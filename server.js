// obscam — signaling + static server.
//
// Dua listener sengaja dipisah:
//   HTTPS (8443) -> halaman sender di HP. getUserMedia butuh secure context.
//   HTTP  (8080) -> halaman receiver untuk OBS Browser Source lewat localhost
//                   (localhost dihitung secure context, jadi tidak kena warning
//                    sertifikat self-signed di dalam CEF-nya OBS).
// Keduanya berbagi satu hub signaling yang sama.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 8443);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/obs') pathname = '/obs.html';

  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  const filePath = path.join(PUBLIC, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(buf);
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

function handleConnection(ws) {
  let id = null;
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      if (id) return; // sudah join
      id = String(nextId++);
      room = String(msg.room || 'default');
      const role = msg.role === 'sender' ? 'sender' : 'viewer';

      if (!rooms.has(room)) rooms.set(room, new Map());
      const peers = rooms.get(room);

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
    if (!id || !room) return;
    const peers = rooms.get(room);
    if (!peers) return;
    peers.delete(id);
    for (const [, p] of peers) send(p.ws, { type: 'peer-leave', id });
    if (peers.size === 0) rooms.delete(room);
    console.log(`[room ${room}] - #${id} (${peers.size} peer)`);
  });
}

function attachWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', handleConnection);
}

// ---- bootstrap -----------------------------------------------------------

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const httpServer = http.createServer(serveStatic);
attachWs(httpServer);
httpServer.listen(HTTP_PORT, () => {
  console.log(`\nOBS Browser Source URL:`);
  console.log(`  http://localhost:${HTTP_PORT}/obs?room=default\n`);
});

const keyPath = path.join(ROOT, 'certs/key.pem');
const certPath = path.join(ROOT, 'certs/cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const httpsServer = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    serveStatic,
  );
  attachWs(httpsServer);
  httpsServer.listen(HTTPS_PORT, () => {
    console.log('Buka di HP (satu WiFi dengan PC ini):');
    for (const ip of lanAddresses()) {
      console.log(`  https://${ip}:${HTTPS_PORT}/?room=default`);
    }
    console.log('\n(Sertifikat self-signed -> browser HP akan warning sekali,');
    console.log(' pilih "Advanced" / "Lanjutkan". Wajib https, kalau tidak');
    console.log(' kamera tidak bisa diakses browser.)\n');
  });
} else {
  console.warn('\n!! certs/ kosong. Jalankan: npm run cert');
  console.warn('   Tanpa HTTPS, halaman kamera di HP tidak akan jalan.\n');
}
