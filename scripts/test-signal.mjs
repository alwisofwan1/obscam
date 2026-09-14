// Smoke test hub signaling: sender & viewer harus saling terlihat dan
// pesan signal harus sampai ke tujuan (dan tidak bocor ke room lain).
import { WebSocket } from 'ws';

const PORT = process.env.HTTP_PORT ?? 8090;
const url = `ws://localhost:${PORT}/ws`;
const log = [];

function client(room, role) {
  const ws = new WebSocket(url);
  const c = { ws, id: null, seen: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'welcome') c.id = m.id;
    c.seen.push(m);
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, role })));
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
console.log(log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
