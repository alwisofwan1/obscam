// Halaman kontrol di PC.
//
// Masuk ke room sebagai viewer biasa — jadi ia dapat video DAN kanal kontrol
// yang sama dengan halaman OBS. Bedanya: halaman ini mengirim perintah balik.
//
// Gunanya sederhana tapi besar: HP nangkring di tripod seberang ruangan.
// Menyetel zoom/eksposur dengan menyentuh HP berarti menggeser framing yang
// baru saja susah payah diatur. Dari sini, tidak ada yang tersentuh.

import { connectSignal, ICE_CONFIG } from './signal.js';
import { wrapChannel } from './link.js';
import { buildProPanel, hint } from './procontrols.js';

const $ = (id) => document.getElementById(id);
const body = document.body;
const params = new URL(location).searchParams;
const room = params.get('room') || 'default';
$('roomName').textContent = room;

let pc = null;
let ms = null;
let link = null;
let senderId = null;

// Cermin state HP. Panel pro dibangun dari sini, bukan dari track lokal —
// halaman ini tidak punya kamera sama sekali.
let remote = { ready: false, caps: {}, settings: {}, modes: {}, silent: [], torch: false, lock: false };

// Nilai yang baru kita kirim tapi belum dikonfirmasi HP. Tanpa ini, slider
// melompat balik ke nilai lama tiap kali state datang.
const pending = new Map();

function send(msg) {
  link?.send(msg);
}

// --- adapter untuk panel bersama ------------------------------------------
// Bentuknya sama persis dengan adapter lokal di sender.js, jadi panel, aturan
// gerbang mode, dan preset Kelvin-nya identik tanpa disalin.

const remoteAdapter = {
  ready: () => remote.ready,
  caps: () => remote.caps,
  settings: () => ({ ...remote.settings, ...Object.fromEntries(pending) }),
  modeOf: (k) => pending.get(k) ?? remote.modes[k] ?? remote.settings[k] ?? null,
  silentModes: () => remote.silent ?? [],
  idleText: 'HP belum mengirim. Tekan “Mulai” di HP — panel ini akan terisi sendiri.',
  apply: async (key, value) => {
    pending.set(key, value);
    send({ type: 'cmd', op: 'apply', key, value });
    // Tidak ada jawaban sinkron dari HP: nilai yang diminta dipakai dulu, lalu
    // dikoreksi saat 'state' berikutnya datang.
    return value;
  },
  setMode: async (key, value) => {
    pending.set(key, value);
    send({ type: 'cmd', op: 'mode', key, value });
    return true;
  },
  footer: () => ['Perintah dikirim ke HP lewat DataChannel. Perubahan yang dilakukan langsung di HP juga muncul di sini.'],
};

function rebuild() {
  buildProPanel({ box: $('pro'), adapter: remoteAdapter });
  buildQuick();
}

// --- kontrol cepat ---------------------------------------------------------

function buildQuick() {
  const z = remote.caps.zoom;
  const r = $('zoomRange');
  const has = !!(z && z.max > z.min);
  r.disabled = !has;
  $('zoomPresets').replaceChildren();
  if (!has) {
    $('zoomVal').textContent = '—';
    $('zoomPresets').append(hint('Lensa ini tidak mengekspos zoom.'));
  } else {
    r.min = z.min;
    r.max = z.max;
    r.step = z.step || (z.max - z.min) / 100;
    const cur = pending.get('zoom') ?? remote.settings.zoom ?? z.min;
    r.value = cur;
    $('zoomVal').textContent = `${Number(cur).toFixed(1)}×`;
    const presets = [...new Set([z.min, Math.min(2, z.max), Math.min(3, z.max), z.max])]
      .filter((v) => v >= z.min && v <= z.max);
    for (const v of presets) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: `${v.toFixed(1)}×` });
      b.onclick = () => setZoom(v);
      $('zoomPresets').append(b);
    }
  }

  $('btnTorch').disabled = !remote.caps.torch;
  $('btnTorch').setAttribute('aria-pressed', String(!!remote.torch));
  $('btnLock').setAttribute('aria-pressed', String(!!remote.lock));
}

function setZoom(v) {
  pending.set('zoom', v);
  $('zoomRange').value = v;
  $('zoomVal').textContent = `${Number(v).toFixed(1)}×`;
  send({ type: 'cmd', op: 'zoom', value: Number(v) });
}

$('zoomRange').oninput = () => { $('zoomVal').textContent = `${Number($('zoomRange').value).toFixed(1)}×`; };
$('zoomRange').onchange = () => setZoom(Number($('zoomRange').value));

$('btnLock').onclick = () => {
  const on = $('btnLock').getAttribute('aria-pressed') !== 'true';
  $('btnLock').setAttribute('aria-pressed', String(on));
  send({ type: 'cmd', op: 'lock', value: on });
};

$('btnTorch').onclick = () => {
  const on = $('btnTorch').getAttribute('aria-pressed') !== 'true';
  $('btnTorch').setAttribute('aria-pressed', String(on));
  send({ type: 'cmd', op: 'torch', value: on });
};

$('btnReset').onclick = () => {
  pending.clear();
  send({ type: 'cmd', op: 'reset' });
};

for (const [tab, pane] of [['tabPro', 'panePro'], ['tabQuick', 'paneQuick']]) {
  $(tab).onclick = () => {
    for (const [t, p] of [['tabPro', 'panePro'], ['tabQuick', 'paneQuick']]) {
      $(t).setAttribute('aria-selected', String(t === tab));
      $(p).classList.toggle('on', p === pane);
    }
  };
}

// --- status ----------------------------------------------------------------

function setStatus(text) {
  $('status').textContent = text;
}

function toggleChip(id, text) {
  const el = $(id);
  el.hidden = !text;
  if (text) el.textContent = text;
}

const LIMIT_LABEL = { cpu: 'CPU HP tidak kuat', bandwidth: 'WiFi tidak kuat', other: 'encoder menahan' };

function onStats(s) {
  toggleChip('chipNet', `${(s.kbps / 1000).toFixed(1)}M · ${s.fps}fps · ${s.rtt}ms`);
  toggleChip('chipFmt', s.width ? `${s.height}p${s.fps}` : '');
  let warn = '';
  if (s.limit && s.limit !== 'none') warn = LIMIT_LABEL[s.limit] ?? s.limit;
  else if (s.loss > 3) warn = `loss ${s.loss.toFixed(1)}%`;
  toggleChip('chipWarn', warn);
  setStatus(`Bitrate: ${(s.kbps / 1000).toFixed(2)} Mbps\nFPS: ${s.fps}\nRTT: ${s.rtt} ms\n` +
    `Loss: ${s.loss.toFixed(2)}%\nEncoder: ${s.encoder || '—'}${s.hardware ? ' (hardware)' : ''}`);
}

// --- WebRTC ----------------------------------------------------------------

function reset() {
  pc?.close();
  pc = null;
  ms = null;
  link = null;
  pending.clear();
  remote = { ready: false, caps: {}, settings: {}, modes: {}, silent: [], torch: false, lock: false };
  $('preview').srcObject = null;
  body.classList.remove('has-cam');
  $('chipState').textContent = 'MENUNGGU';
  for (const id of ['chipFmt', 'chipNet', 'chipWarn']) toggleChip(id, '');
  setStatus('Menunggu HP…');
  rebuild();
}

function newPeer(sid) {
  pc?.close();
  pc = new RTCPeerConnection(ICE_CONFIG);
  ms = new MediaStream();

  pc.ontrack = (e) => {
    ms.addTrack(e.track);
    if ($('preview').srcObject !== ms) $('preview').srcObject = ms;
    $('preview').play().catch(() => {});
    body.classList.add('has-cam');
    $('chipState').textContent = 'TERSAMBUNG';
  };

  pc.ondatachannel = (e) => {
    link = wrapChannel(e.channel, (msg) => {
      if (msg.type === 'state') {
        remote = { ...remote, ...msg };
        // State dari HP adalah kebenaran; buang tebakan optimistis kita.
        for (const [k, v] of [...pending]) {
          const actual = msg.modes?.[k] ?? msg.settings?.[k];
          if (actual === v) pending.delete(k);
        }
        rebuild();
      } else if (msg.type === 'stats') {
        onStats(msg);
      }
    });
    // Sapa dulu supaya HP langsung mengirim state penuh, bukan menunggu
    // perubahan berikutnya.
    link.send({ type: 'hello', role: 'control' });
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) sig.signal(sid, { candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) reset();
  };
  return pc;
}

const sig = connectSignal({
  room,
  role: 'viewer',
  onWelcome: () => reset(),
  onError: (reason) => {
    $('chipState').textContent = 'DITOLAK';
    setStatus(`Ditolak server: ${reason}\nPakai URL lengkap dari terminal PC (ada ?k=...).`);
  },
  onPeerLeave: ({ id }) => { if (id === senderId) reset(); },
  onSignal: async (from, data) => {
    if (data.sdp?.type === 'offer') {
      const fresh = from !== senderId || !pc || pc.connectionState === 'closed';
      senderId = from;
      const p = fresh ? newPeer(from) : pc;
      await p.setRemoteDescription(data.sdp);
      const answer = await p.createAnswer();
      await p.setLocalDescription(answer);
      sig.signal(from, { sdp: p.localDescription });
    } else if (data.bye) {
      if (from === senderId) reset();
    } else if (data.candidate && pc) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  },
});

rebuild();
