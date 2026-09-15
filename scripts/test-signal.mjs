// Smoke test hub signaling: sender & viewer harus saling terlihat dan
// pesan signal harus sampai ke tujuan (dan tidak bocor ke room lain).
import fs from 'node:fs';
import { WebSocket } from 'ws';

const PORT = process.env.HTTP_PORT ?? 8090;
const url = `ws://localhost:${PORT}/ws`;
const log = [];

// Server auto-generate token ke certs/token. Test ikut membacanya supaya
// tidak perlu mematikan auth.
const TOKEN = process.env.OBSCAM_TOKEN
  ?? (() => { try { return fs.readFileSync('certs/token', 'utf8').trim(); } catch { return ''; } })();

function client(room, role, token = TOKEN) {
  const ws = new WebSocket(url);
  const c = { ws, id: null, seen: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'welcome') c.id = m.id;
    c.seen.push(m);
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, role, token })));
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const viewer = client('r1', 'viewer');
await wait(200);
const sender = client('r1', 'sender');
const intruder = client('r2', 'viewer');
await wait(300);

const check = (name, ok) => log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);

check('viewer dapat peer-join sender', viewer.seen.some((m) => m.type === 'peer-join' && m.role === 'sender'));
check('sender lihat viewer di welcome', sender.seen[0]?.peers?.some((p) => p.role === 'viewer'));

sender.ws.send(JSON.stringify({ type: 'signal', to: viewer.id, data: { sdp: 'FAKE_OFFER' } }));
await wait(200);
check('signal sampai ke viewer', viewer.seen.some((m) => m.type === 'signal' && m.data.sdp === 'FAKE_OFFER'));
check('room lain tidak kebocoran', !intruder.seen.some((m) => m.type === 'signal' || m.type === 'peer-join'));

sender.ws.close();
await wait(250);
check('viewer dapat peer-leave', viewer.seen.some((m) => m.type === 'peer-leave'));

viewer.ws.close();
intruder.ws.close();

// --- hardening ------------------------------------------------------------
if (TOKEN) {
  const badToken = client('r3', 'viewer', 'salah');
  await wait(250);
  check('token salah ditolak', badToken.seen.some((m) => m.type === 'error' && m.reason === 'bad-token'));
  badToken.ws.close();
}

const badRoom = client('r4/../etc', 'viewer');
await wait(250);
check('nama room invalid ditolak', badRoom.seen.some((m) => m.type === 'error' && m.reason === 'bad-room'));
badRoom.ws.close();

const s1 = client('r5', 'sender');
await wait(200);
const s2 = client('r5', 'sender');
await wait(250);
check('sender kedua di room sama ditolak', s2.seen.some((m) => m.type === 'error' && m.reason === 'sender-taken'));
s1.ws.close();
s2.ws.close();
await wait(150);
console.log(log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
