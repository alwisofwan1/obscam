// obscam — signaling + static server.
//
// Dua listener sengaja dipisah:
//   HTTPS (8443, bind 0.0.0.0) -> halaman sender di HP. getUserMedia butuh
//                   secure context, jadi ini satu-satunya port yang terbuka
//                   ke LAN.
//   HTTP  (8080, bind 127.0.0.1) -> halaman receiver untuk OBS Browser Source.
//                   localhost dihitung secure context, jadi tidak kena warning
//                   sertifikat self-signed di dalam CEF-nya OBS. Sengaja TIDAK
//                   didengarkan di LAN supaya tidak ada jalur plaintext keluar.
// Keduanya berbagi satu hub signaling yang sama.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CERTS = path.join(ROOT, 'certs');
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 8443);
const HTTP_HOST = process.env.HTTP_HOST ?? '127.0.0.1';

// Batas-batas: server ini duduk di LAN tanpa reverse proxy, jadi semua
// pembatasan harus dilakukan sendiri.
const LIMITS = {
  maxPayload: 256 * 1024,   // SDP besar ~10 KB; 256 KB sudah sangat longgar
  msgPerSec: 120,           // ICE burst bisa puluhan pesan, 120/s cukup
  peersPerRoom: 8,
  maxRooms: 32,
  sendersPerRoom: 1,        // room dikunci ke satu HP; cegah takeover
  roomNameRe: /^[A-Za-z0-9_-]{1,32}$/,
  heartbeatMs: 30_000,
};

// ---- auth ----------------------------------------------------------------
// Token bersama: tanpa ini siapa pun di LAN yang menebak nama room bisa ikut
// mengintip. Disimpan di certs/token supaya URL OBS tidak berubah tiap restart.

const NO_AUTH = process.env.OBSCAM_NO_AUTH === '1';

function loadToken() {
  if (NO_AUTH) return null;
  if (process.env.OBSCAM_TOKEN) return process.env.OBSCAM_TOKEN;
  const file = path.join(CERTS, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(16).toString('base64url');
  fs.mkdirSync(CERTS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

const TOKEN = loadToken();

function tokenOk(given) {
  if (!TOKEN) return true;
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- static --------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// Halaman ini seluruhnya lokal — tidak ada CDN, tidak ada koneksi keluar.
// CSP dikunci ketat supaya XSS lewat query string tidak bisa menarik apa pun.
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(self), microphone=(self), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname.includes('\0')) {
    res.writeHead(400).end('bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/obs') pathname = '/obs.html';
  if (pathname === '/control') pathname = '/control.html';

  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  // path.resolve + pemisah eksplisit: `startsWith(PUBLIC)` saja masih lolos
  // untuk sibling seperti `<root>/publicX`.
  const filePath = path.resolve(PUBLIC, '.' + path.posix.normalize(pathname));
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain', ...SECURITY_HEADERS }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

// ---- signaling hub -------------------------------------------------------
// Server tidak pernah menyentuh media; cuma meneruskan SDP/ICE antar peer
// di dalam room yang sama.

/** @type {Map<string, Map<string, {ws: import('ws').WebSocket, role: string}>>} */
const rooms = new Map();
let nextId = 1;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function bail(ws, reason) {
  send(ws, { type: 'error', reason });
  ws.close(1008, reason);
}

function handleConnection(ws) {
  let id = null;
  let room = null;
  let budget = LIMITS.msgPerSec;

  const refill = setInterval(() => { budget = LIMITS.msgPerSec; }, 1000);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (budget-- <= 0) return bail(ws, 'rate-limit');

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      if (id) return; // sudah join
      if (!tokenOk(msg.token)) return bail(ws, 'bad-token');

      const name = String(msg.room ?? 'default');
      if (!LIMITS.roomNameRe.test(name)) return bail(ws, 'bad-room');
      if (!rooms.has(name) && rooms.size >= LIMITS.maxRooms) return bail(ws, 'too-many-rooms');

      const role = msg.role === 'sender' ? 'sender' : 'viewer';
      const peers = rooms.get(name) ?? new Map();
      if (peers.size >= LIMITS.peersPerRoom) return bail(ws, 'room-full');
      if (role === 'sender') {
        const senders = [...peers.values()].filter((p) => p.role === 'sender').length;
        if (senders >= LIMITS.sendersPerRoom) return bail(ws, 'sender-taken');
      }

      rooms.set(name, peers);
      id = String(nextId++);
      room = name;

      send(ws, {
        type: 'welcome',
        id,
        peers: [...peers].map(([pid, p]) => ({ id: pid, role: p.role })),
      });
      for (const [, p] of peers) send(p.ws, { type: 'peer-join', id, role });

      peers.set(id, { ws, role });
      console.log(`[room ${room}] + ${role} #${id} (${peers.size} peer)`);
      return;
    }

    if (msg.type === 'signal' && id && room) {
      const target = rooms.get(room)?.get(String(msg.to));
      if (target) send(target.ws, { type: 'signal', from: id, data: msg.data });
    }
  });

  ws.on('close', () => {
    clearInterval(refill);
    if (!id || !room) return;
    const peers = rooms.get(room);
    if (!peers) return;
    peers.delete(id);
    for (const [, p] of peers) send(p.ws, { type: 'peer-leave', id });
    if (peers.size === 0) rooms.delete(room);
    console.log(`[room ${room}] - #${id} (${peers.size} peer)`);
  });

  ws.on('error', () => ws.close());
}

function attachWs(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: LIMITS.maxPayload,
    // Tolak koneksi lintas-origin: halaman jahat yang dibuka di HP tidak bisa
    // diam-diam menyambung ke hub ini.
    verifyClient: ({ origin, req }) => {
      if (!origin) return true; // klien non-browser (test script)
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    },
  });
  wss.on('connection', handleConnection);

  // Socket mati (HP masuk tunnel / WiFi putus) tidak memicu 'close' sampai
  // TCP timeout. Ping berkala membereskannya supaya OBS cepat balik idle.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, LIMITS.heartbeatMs);
  beat.unref();

  return wss;
}

// ---- bootstrap -----------------------------------------------------------

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const q = TOKEN ? `&k=${TOKEN}` : '';

const httpServer = http.createServer(serveStatic);
attachWs(httpServer);
httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`\nOBS Browser Source URL:`);
  console.log(`  http://localhost:${HTTP_PORT}/obs?room=default${q}&nohud=1`);
  console.log(`\nPanel kontrol kamera (buka di browser PC):`);
  console.log(`  http://localhost:${HTTP_PORT}/control?room=default${q}\n`);
});

const keyPath = path.join(CERTS, 'key.pem');
const certPath = path.join(CERTS, 'cert.pem');

let httpsServer = null;
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  httpsServer = https.createServer(
    {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
      minVersion: 'TLSv1.2',
      honorCipherOrder: true,
    },
    serveStatic,
  );
  attachWs(httpsServer);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log('Buka di HP (satu WiFi dengan PC ini):');
    for (const ip of lanAddresses()) {
      console.log(`  https://${ip}:${HTTPS_PORT}/?room=default${q}`);
    }
    console.log('\n(Sertifikat self-signed -> browser HP akan warning sekali,');
    console.log(' pilih "Advanced" / "Lanjutkan". Wajib https, kalau tidak');
    console.log(' kamera tidak bisa diakses browser.)');
  });
} else {
  console.warn('\n!! certs/ kosong. Jalankan: npm run cert');
  console.warn('   Tanpa HTTPS, halaman kamera di HP tidak akan jalan.');
}

if (TOKEN) {
  console.log(`\nToken room: ${TOKEN}`);
  console.log('  Wajib ada di URL (?k=...). Tersimpan di certs/token.');
  console.log('  Ganti: hapus file itu lalu restart, atau set OBSCAM_TOKEN=...');
  console.log('  Matikan (LAN tepercaya): OBSCAM_NO_AUTH=1 npm start\n');
} else {
  console.warn('\n!! Auth dimatikan (OBSCAM_NO_AUTH=1) — siapa pun di LAN bisa ikut.\n');
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    httpServer.close();
    httpsServer?.close();
    process.exit(0);
  });
}
