// Klien signaling tipis di atas WebSocket. Dipakai sender & receiver.
// Otomatis pilih ws:// atau wss:// mengikuti skema halaman.

export function connectSignal({ room, role, onWelcome, onPeerJoin, onPeerLeave, onSignal, onStatus }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  let selfId = null;
  let closed = false;
  let retry = 0;

  function open() {
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      retry = 0;
      onStatus?.('signaling tersambung');
      ws.send(JSON.stringify({ type: 'join', room, role }));
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'welcome') {
        selfId = msg.id;
        onWelcome?.(msg);
      } else if (msg.type === 'peer-join') {
        onPeerJoin?.(msg);
      } else if (msg.type === 'peer-leave') {
        onPeerLeave?.(msg);
      } else if (msg.type === 'signal') {
        onSignal?.(msg.from, msg.data);
      }
    };

    ws.onclose = () => {
      if (closed) return;
      // Reconnect dengan backoff — penting karena OBS bisa saja start
      // sebelum server hidup, dan HP suka putus saat layar mati.
      const delay = Math.min(1000 * 2 ** retry++, 10000);
      onStatus?.(`terputus, reconnect ${delay / 1000}s...`);
      setTimeout(open, delay);
    };

    ws.onerror = () => ws.close();
  }

  open();

  return {
    signal(to, data) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'signal', to, data }));
      }
    },
    get id() {
      return selfId;
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}

// LAN murni: host candidate sudah cukup, tidak perlu STUN/TURN.
// Kalau nanti mau lintas jaringan, tambahkan STUN di sini.
export const ICE_CONFIG = { iceServers: [] };
