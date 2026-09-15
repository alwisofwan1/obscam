// Kanal kontrol di atas WebRTC DataChannel.
//
// Satu kanal melayani dua hal yang sama-sama butuh jalur balik dari PC ke HP:
//
//   tally   — halaman OBS tahu kapan source-nya on-air; HP tidak. Tanpa jalur
//             ini, operator di balik kamera tidak punya cara tahu dia sedang
//             disiarkan. Itu perlengkapan standar setiap kamera broadcast.
//   kontrol — HP nangkring di tripod seberang ruangan. Menyetel zoom/eksposur
//             berarti menyentuh HP-nya, dan menyentuh HP berarti menggeser
//             framing. Panel di PC menghilangkan itu sepenuhnya.
//
// Dipakai lewat signaling yang sama, jadi tidak ada port atau auth tambahan.

export const CHANNEL = 'obscam-ctl';

/**
 * Bungkus RTCDataChannel: antre pesan sampai kanalnya terbuka, dan jangan
 * pernah melempar. Kanal kontrol yang putus tidak boleh menjatuhkan video.
 */
export function wrapChannel(dc, onMessage) {
  const queue = [];

  const flush = () => {
    while (queue.length && dc.readyState === 'open') {
      try { dc.send(queue.shift()); } catch { break; }
    }
  };

  dc.onopen = flush;
  dc.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg && typeof msg === 'object') onMessage?.(msg);
  };
  dc.onerror = () => {};

  return {
    send(msg) {
      const raw = JSON.stringify(msg);
      if (dc.readyState === 'open') {
        try { dc.send(raw); } catch { queue.push(raw); }
      } else if (dc.readyState === 'connecting') {
        queue.push(raw);
      }
      // 'closing'/'closed': buang saja. Pengirim akan mengirim state penuh
      // lagi saat peer berikutnya menyambung.
    },
    get open() { return dc.readyState === 'open'; },
    close() { try { dc.close(); } catch {} },
  };
}

/**
 * Status tally gabungan -> satu kata.
 * program menang atas preview: kalau sedang on-air, itu yang harus terlihat.
 */
export function tallyState(t) {
  if (!t) return 'off';
  if (t.program) return 'program';
  if (t.preview) return 'preview';
  return 'idle';
}

// Kontrol yang boleh dijalankan dari jarak jauh. Daftar putih eksplisit:
// pesan datang dari halaman lain, jadi jangan pernah meneruskan key sembarang
// ke applyConstraints.
export const REMOTE_OPS = new Set(['apply', 'mode', 'zoom', 'torch', 'lock', 'reset']);

export const REMOTE_KEYS = new Set([
  'exposureMode', 'exposureCompensation', 'exposureTime', 'iso',
  'focusMode', 'focusDistance',
  'whiteBalanceMode', 'colorTemperature',
  'brightness', 'contrast', 'saturation', 'sharpness',
  'zoom',
]);

export function validCommand(msg) {
  if (!msg || msg.type !== 'cmd' || !REMOTE_OPS.has(msg.op)) return false;
  if (msg.op === 'apply' || msg.op === 'mode') {
    if (!REMOTE_KEYS.has(msg.key)) return false;
    const t = typeof msg.value;
    return t === 'number' || t === 'string';
  }
  if (msg.op === 'zoom') return typeof msg.value === 'number' && Number.isFinite(msg.value);
  if (msg.op === 'torch' || msg.op === 'lock') return typeof msg.value === 'boolean';
  return true; // reset
}
