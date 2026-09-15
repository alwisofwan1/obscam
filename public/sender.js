// Halaman sender: merangkai camera.js, transport.js, dan UI landscape-first.
// Modul ini sengaja hanya berisi perekat + UI; logika kamera dan WebRTC ada
// di modulnya masing-masing.

import { connectSignal } from './signal.js';
import { createCamera } from './camera.js';
import { buildProPanel, hint } from './procontrols.js';
import { tallyState, validCommand } from './link.js';
import { createTransport, videoCodecOptions } from './transport.js';
import { prefs, looks } from './store.js';
import {
  createOverlay, createMeter,
  ZEBRA_LEVELS, PEAK_LEVELS, HIST_MODES, GUIDE_MODES,
} from './overlay.js';

const $ = (id) => document.getElementById(id);
const body = document.body;

const room = new URL(location).searchParams.get('room') || 'default';
$('roomName').textContent = room;

const cam = createCamera();
let live = false;
let fatal = null;
let wakeLock = null;
const knownViewers = new Set();

// --- config ---------------------------------------------------------------

const getConfig = () => ({
  bitrate: $('bitrate').value,
  codec: $('codec').value,
  degradation: $('degradation').value,
});

const tracks = () => ({ video: cam.videoTrack, audio: cam.audioTrack });

// --- signaling + transport ------------------------------------------------

const REASONS = {
  'bad-token': 'Token salah/hilang. Buka URL lengkap dari terminal PC (ada ?k=...).',
  'sender-taken': 'Room ini sudah dipakai HP lain. Tutup tab sender yang lama atau pakai room lain.',
  'room-full': 'Room penuh.',
  'bad-room': 'Nama room tidak valid (huruf/angka/-/_ maks 32).',
  'rate-limit': 'Terlalu banyak pesan — koneksi diputus server.',
  'too-many-rooms': 'Server sudah menampung terlalu banyak room.',
};

const tx = createTransport({
  signal: (to, data) => sig.signal(to, data),
  getConfig,
  onChange: () => refreshStatus(),
  onMessage: (from, msg) => handleLink(from, msg),
});

// --- tally & kendali jarak jauh -------------------------------------------

// Tally disimpan PER viewer, bukan satu nilai global. Bisa ada beberapa
// Browser Source di scene berbeda; yang satu program, yang lain tidak. Dan
// saat satu halaman OBS ditutup, statusnya harus ikut hilang — bukan
// meninggalkan lampu ON AIR menyala selamanya.
const tallies = new Map();
let tally = { program: false, preview: false, streaming: false, recording: false };

function recomputeTally() {
  const any = (k) => [...tallies.values()].some((t) => t[k]);
  tally = { program: any('program'), preview: any('preview'), streaming: any('streaming'), recording: any('recording') };
  applyTally();
}

function dropTally(id) {
  if (tallies.delete(id)) recomputeTally();
}

function handleLink(from, msg) {
  if (msg.type === 'tally') {
    tallies.set(from, {
      program: !!msg.program,
      preview: !!msg.preview,
      streaming: !!msg.streaming,
      recording: !!msg.recording,
    });
    recomputeTally();
    return;
  }
  if (msg.type === 'hello') {
    // Panel /control baru menyambung: kirim state penuh supaya panelnya bisa
    // langsung dibangun tanpa menunggu perubahan berikutnya.
    publishState(from);
    return;
  }
  if (msg.type === 'cmd') runCommand(msg);
}

function applyTally() {
  const state = tallyState(tally);
  body.dataset.tally = state;
  const label = { program: 'ON AIR', preview: 'PREVIEW', idle: '', off: '' }[state] ?? '';
  toggleChip('chipTally', label);
  $('chipTally').className = `chip ${state === 'program' ? 'bad' : 'ok'}`;
  const rec = [tally.recording && 'REC', tally.streaming && 'LIVE OBS'].filter(Boolean).join(' · ');
  toggleChip('chipObs', rec);
}

async function runCommand(msg) {
  // Perintah datang dari halaman lain; jangan pernah meneruskan key sembarang
  // ke applyConstraints.
  if (!validCommand(msg) || !cam.videoTrack) return;
  if (msg.op === 'apply') await cam.apply(msg.key, msg.value);
  else if (msg.op === 'mode') await cam.setMode(msg.key, msg.value);
  else if (msg.op === 'zoom') await setZoom(msg.value);
  else if (msg.op === 'torch') { if (await cam.setTorch(msg.value)) setPressed('btnTorch', msg.value); }
  else if (msg.op === 'lock') { setPressed('btnAeLock', await cam.setLock(msg.value) && msg.value); }
  else if (msg.op === 'reset') await cam.resetAuto();
  buildPro();
  buildZoom();
}

/** Pancarkan kapabilitas + nilai berjalan supaya panel di PC bisa menirunya. */
function publishState(to = null) {
  if (!tx.size) return;
  const modes = {};
  for (const k of ['exposureMode', 'focusMode', 'whiteBalanceMode']) modes[k] = cam.modeOf(k);
  tx.post({
    type: 'state',
    ready: !!cam.videoTrack,
    caps: cam.caps,
    settings: cam.settings,
    modes,
    silent: cam.silentModes(),
    torch: isPressed('btnTorch'),
    lock: isPressed('btnAeLock'),
  }, to);
}

const sig = connectSignal({
  room,
  role: 'sender',
  onWelcome: ({ peers: existing }) => {
    // Setelah reconnect, semua id lama tidak valid lagi.
    tx.removeAll();
    knownViewers.clear();
    existing.filter((p) => p.role === 'viewer').forEach((p) => knownViewers.add(p.id));
    if (live) connectAllViewers();
  },
  onPeerJoin: ({ id, role }) => {
    if (role !== 'viewer') return;
    knownViewers.add(id);
    if (live) tx.add(id, tracks());
  },
  onPeerLeave: ({ id }) => {
    knownViewers.delete(id);
    dropTally(id);
    tx.remove(id);
  },
  onSignal: (from, data) => tx.onSignal(from, data),
  onError: (reason) => {
    fatal = REASONS[reason] ?? reason;
    $('btnGo').disabled = true;
    refreshStatus();
  },
  onStatus: () => refreshStatus(),
});

function connectAllViewers() {
  for (const id of knownViewers) if (!tx.has(id)) tx.add(id, tracks());
}

// --- status & telemetri ---------------------------------------------------

function refreshStatus() {
  // Peer bisa hilang lewat ICE failed, bukan hanya lewat peer-leave.
  for (const id of [...tallies.keys()]) if (!tx.has(id)) { tallies.delete(id); }

  if (fatal) {
    $('status').replaceChildren(
      Object.assign(document.createElement('span'), { className: 'warn', textContent: `Ditolak server: ${fatal}` }),
    );
    $('chipState').textContent = 'ERROR';
    return;
  }

  const s = cam.settings;
  const size = s.width ? `${s.width}×${s.height}@${Math.round(s.frameRate ?? 0)}` : '—';
  // E2E dan operator sama-sama membaca baris ini; jaga formatnya.
  const st = tx.stats;
  $('status').textContent =
    `Status: ${live ? 'LIVE' : 'idle'}\n` +
    `Viewer (OBS) tersambung: ${tx.size}\n` +
    `Kamera aktual: ${size}\n` +
    `Room: ${room}` +
    (st
      ? `\n\nDikirim: ${st.width}×${st.height}@${st.fps} · ${(st.kbps / 1000).toFixed(2)} Mbps\n` +
        `Encoder: ${st.encoder || '—'} (${st.hardware ? 'hardware' : 'SOFTWARE'})\n` +
        `Pembatas: ${st.limit}\n` +
        `Rem otomatis: ${BRAKE_STEPS[brakeStep].label || 'tidak aktif'}`
      : '');

  $('chipState').textContent = live ? 'LIVE' : 'IDLE';
  body.classList.toggle('live', live);

  toggleChip('chipFmt', s.width ? `${s.height}p${Math.round(s.frameRate ?? 0)}` : '');
  toggleChip('chipViewers', live ? `${tx.size} viewer` : '');
}

function toggleChip(id, text) {
  const el = $(id);
  el.hidden = !text;
  if (text) el.textContent = text;
}

const LIMIT_LABEL = { cpu: 'CPU HP tidak kuat', bandwidth: 'WiFi tidak kuat', other: 'encoder menahan' };

// Tangga rem. Turun satu anak tangga tiap 5 detik CPU mentok, naik lagi
// setelah 20 detik lega — pemulihan sengaja jauh lebih lambat daripada
// penurunan supaya tidak berayun-ayun di ambang batas.
const BRAKE_STEPS = [
  { scale: 1, fps: 0, label: '' },
  { scale: 1, fps: 30, label: 'fps dibatasi 30' },
  { scale: 1.5, fps: 30, label: 'skala 1,5× · fps 30' },
  { scale: 2, fps: 30, label: 'skala 2× · fps 30' },
];

let brakeStep = 0;
let cpuStreak = 0;
let calmStreak = 0;

function autoBrake(st) {
  if (!prefs.get('autoBrake')) {
    if (brakeStep) { brakeStep = 0; tx.setBrake(BRAKE_STEPS[0]); }
    return;
  }

  const strained = st.limit === 'cpu';
  cpuStreak = strained ? cpuStreak + 1 : 0;
  calmStreak = strained ? 0 : calmStreak + 1;

  let next = brakeStep;
  if (cpuStreak >= 5 && brakeStep < BRAKE_STEPS.length - 1) next = brakeStep + 1;
  else if (calmStreak >= 20 && brakeStep > 0) next = brakeStep - 1;
  if (next === brakeStep) return;

  brakeStep = next;
  cpuStreak = 0;
  calmStreak = 0;
  tx.setBrake(BRAKE_STEPS[brakeStep]);
  // Overlay ikut mengalah saat encoder sedang sesak.
  overlay.setInterval(brakeStep ? 400 : 150);
  refreshStatus();
}

async function pollStats() {
  const st = await tx.sampleStats();
  if (!st) { toggleChip('chipNet', ''); toggleChip('chipWarn', ''); return; }

  toggleChip('chipNet', `${(st.kbps / 1000).toFixed(1)}M · ${st.fps}fps · ${st.rtt}ms`);
  tx.post({ type: 'stats', ...st });

  autoBrake(st);

  // Satu peringatan pada satu waktu, yang paling penting dulu. Operator tidak
  // punya waktu membaca tiga chip saat sedang merekam.
  //
  // "CPU" saja tidak bisa ditindak. Kalau encoder-nya ternyata software,
  // ITU sebabnya, dan gantinya jelas: pindah ke H.264. Digabung supaya
  // penyebabnya ikut terbaca, bukan cuma gejalanya.
  let warn = '';
  if (st.limit === 'cpu' && st.encoder && !st.hardware) warn = 'CPU — encoder software, ganti ke H.264';
  else if (st.limit !== 'none') warn = LIMIT_LABEL[st.limit] ?? st.limit;
  else if (st.encoder && !st.hardware) warn = 'encoder software';
  else if (st.loss > 3) warn = `loss ${st.loss.toFixed(1)}%`;
  else if (isPortrait() && live) warn = 'putar ke landscape';
  toggleChip('chipWarn', warn);
  toggleChip('chipBrake', BRAKE_STEPS[brakeStep].label);
}

setInterval(() => { if (live) pollStats(); }, 1000);

const isPortrait = () => window.matchMedia('(orientation: portrait)').matches;

// --- kamera ---------------------------------------------------------------

async function refreshCameraList() {
  const cams = await cam.listCameras();
  const keep = $('cam').value || prefs.get('camId');
  $('cam').replaceChildren(
    ...cams.map((c) => Object.assign(document.createElement('option'), { value: c.id, textContent: c.label })),
  );
  if (keep && cams.some((c) => c.id === keep)) $('cam').value = keep;
}

async function openCamera() {
  const [w, h] = $('res').value.split('x').map(Number);
  await cam.open({
    deviceId: $('cam').value || undefined,
    width: w,
    height: h,
    frameRate: Number($('fps').value),
  });

  await refreshCameraList();
  if (!$('cam').value && cam.deviceId) $('cam').value = cam.deviceId;
  prefs.set('camId', $('cam').value);

  $('preview').srcObject = cam.stream;
  body.classList.add('has-cam');

  $('btnTorch').disabled = !cam.caps.torch;
  setPressed('btnTorch', false);
  setPressed('btnAeLock', false);

  buildZoom();
  buildPro();
  syncMonitor();
  refreshStatus();
}

// --- zoom rail ------------------------------------------------------------

function buildZoom() {
  const z = cam.caps.zoom;
  body.classList.toggle('has-zoom', !!(z && z.max > z.min));
  if (!z) return;
  const r = $('zoomRange');
  r.min = z.min;
  r.max = z.max;
  r.step = z.step || (z.max - z.min) / 100;
  r.value = cam.settings.zoom ?? z.min;
  $('zp1').textContent = `${z.min}×`;
  // Preset kedua ditaruh di tengah rentang kalau 2× di luar jangkauan lensa.
  const mid = z.max >= 2 ? 2 : Math.round(((z.min + z.max) / 2) * 10) / 10;
  $('zp2').textContent = `${mid}×`;
  $('zp2').dataset.z = mid;
  $('zpMax').textContent = `${Math.round(z.max)}×`;
  $('zpMax').dataset.z = z.max;
  $('zp1').dataset.z = z.min;
  markZoomPreset(Number(r.value));
}

function markZoomPreset(value) {
  for (const id of ['zp1', 'zp2', 'zpMax']) {
    $(id).setAttribute('aria-pressed', String(Math.abs(Number($(id).dataset.z) - value) < 0.05));
  }
}

async function setZoom(value) {
  const actual = await cam.setZoom(value);
  const v = actual ?? value;
  $('zoomRange').value = v;
  markZoomPreset(Number(v));
}

$('zoomRange').oninput = () => markZoomPreset(Number($('zoomRange').value));
// 'change' bukan 'input': applyConstraints tiap pixel geser bikin kamera
// tersendat di HP kelas menengah.
$('zoomRange').onchange = () => setZoom(Number($('zoomRange').value));
for (const id of ['zp1', 'zp2', 'zpMax']) {
  $(id).onclick = () => setZoom(Number($(id).dataset.z));
}

// --- panel pro ------------------------------------------------------------
// Panelnya sendiri ada di procontrols.js; halaman ini hanya menyuplai adapter
// yang bicara langsung ke kamera lokal. Halaman /control menyuplai adapter
// yang bicara lewat DataChannel — UI dan aturan gerbangnya identik.

const localAdapter = {
  ready: () => !!cam.videoTrack,
  caps: () => cam.caps,
  settings: () => cam.settings,
  modeOf: (k) => cam.modeOf(k),
  apply: (k, v) => cam.apply(k, v),
  setMode: (k, v) => cam.setMode(k, v),
  silentModes: () => cam.silentModes(),
  footer: () => (cam.supportsPoi
    ? ['Ketuk preview untuk menentukan titik fokus. Tekan-tahan preview untuk mengunci eksposur/fokus/WB.']
    : ['Tap-to-focus tidak didukung browser ini.']),
};

function buildPro() {
  buildProPanel({ box: $('pro'), adapter: localAdapter });
  publishState();
}

// --- looks ----------------------------------------------------------------

function renderLooks() {
  const id = cam.deviceId;
  const list = $('lookList');
  const names = looks.list(id);
  list.replaceChildren();
  if (!names.length) { list.append(hint('Belum ada Look tersimpan untuk lensa ini.')); return; }
  for (const name of names) {
    const el = document.createElement('div');
    el.className = 'look';
    el.append(Object.assign(document.createElement('span'), { textContent: name }));
    const apply = Object.assign(document.createElement('button'), { type: 'button', textContent: '▶', title: 'Terapkan' });
    apply.onclick = async () => { await cam.applyLook(looks.get(id, name) ?? {}); buildPro(); buildZoom(); };
    const del = Object.assign(document.createElement('button'), { type: 'button', textContent: '✕', title: 'Hapus' });
    del.onclick = () => { looks.remove(id, name); renderLooks(); };
    el.append(apply, del);
    list.append(el);
  }
}

$('btnLookSave').onclick = () => {
  const name = $('lookName').value.trim();
  if (!name || !cam.videoTrack) return;
  looks.save(cam.deviceId, name, cam.snapshot());
  $('lookName').value = '';
  renderLooks();
};

$('btnResetAuto').onclick = async () => {
  await cam.resetAuto();
  buildPro();
  buildZoom();
};

// --- alat monitor ---------------------------------------------------------

const monitorConfig = () => ({
  hist: prefs.get('hist'),
  zebra: prefs.get('zebra'),
  peak: prefs.get('peak'),
  falseColor: prefs.get('falseColor') === true || prefs.get('falseColor') === 'true',
  guides: prefs.get('guides'),
  fit: isPressed('btnFit') ? 'cover' : 'contain',
});

const overlay = createOverlay({
  video: $('preview'),
  canvas: $('guides'),
  scope: $('scope'),
  getConfig: monitorConfig,
});

const meter = createMeter({ bar: $('meterBar'), peakEl: $('meterPeak') });

function scopesOn() {
  const c = monitorConfig();
  return c.hist !== 'off' || c.zebra !== 'off' || c.peak !== 'off' || c.falseColor;
}

function syncMonitor() {
  const c = monitorConfig();
  body.classList.toggle('has-scope', c.hist !== 'off');
  setPressed('btnScope', scopesOn());
  setPressed('btnGuides', c.guides !== 'off');
  syncPower();
}

/**
 * Menentukan apa yang boleh memakai CPU sekarang.
 *
 * Sebelumnya overlay dan meter terus berjalan walau tidak ada yang melihatnya:
 * saat chrome menyembunyikan diri, saat mode gelap, dan saat tab di
 * background. CSS hanya menyembunyikannya — loop-nya tetap membaca balik frame
 * dari GPU dan menganalisis 36 ribu piksel, 6,7 kali per detik, untuk layar
 * yang sedang hitam.
 */
function syncPower() {
  const c = monitorConfig();
  const wanted = !!cam.videoTrack && (scopesOn() || c.guides !== 'off');
  const hidden = document.hidden
    || body.classList.contains('blackout')
    || (body.classList.contains('idle') && scopesOn());

  if (!wanted) overlay.stop();
  else if (hidden) overlay.pause();
  else overlay.start();

  // Meter audio ikut berhenti — tidak ada gunanya menghitung peak untuk
  // batang yang sedang tidak terlihat.
  const meterVisible = !!cam.audioTrack
    && !document.hidden
    && !body.classList.contains('blackout')
    && !body.classList.contains('idle');
  if (meterVisible) meter.resume();
  else meter.pause();
}

window.addEventListener('resize', () => overlay.resize());
window.addEventListener('orientationchange', () => setTimeout(() => overlay.resize(), 200));

// --- chrome auto-hide -----------------------------------------------------

let idleTimer = null;

function poke() {
  const was = body.classList.contains('idle');
  body.classList.remove('idle');
  if (was) syncPower();
  clearTimeout(idleTimer);
  // Hanya sembunyikan saat sedang live dan panel tertutup — kalau tidak,
  // halaman idle akan terlihat seperti rusak.
  if (!live || body.classList.contains('drawer') || body.classList.contains('locked')) return;
  idleTimer = setTimeout(() => { body.classList.add('idle'); syncPower(); }, 4000);
}

for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, poke, { capture: true });

// --- gesture di stage -----------------------------------------------------

const stage = $('stage');
const pointers = new Map();
let pinchStart = null;
let pressTimer = null;
let moved = false;
let downAt = 0;

stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, e);
  moved = false;
  downAt = Date.now();

  if (pointers.size === 2) {
    clearTimeout(pressTimer);
    const [a, b] = [...pointers.values()];
    pinchStart = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: Number($('zoomRange').value) };
  } else if (pointers.size === 1) {
    // Tekan-tahan = kunci AE/AF/AWB. Ini kontrol paling berharga di lapangan,
    // jadi diberi gesture yang tidak mungkin terpicu tanpa sengaja.
    pressTimer = setTimeout(() => { moved = true; toggleAeLock(); }, 600);
  }
});

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  if (Math.hypot(e.clientX - prev.clientX, e.clientY - prev.clientY) > 8) { moved = true; clearTimeout(pressTimer); }
  pointers.set(e.pointerId, e);

  if (pointers.size === 2 && pinchStart && cam.caps.zoom) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const { min, max } = cam.caps.zoom;
    const next = Math.min(max, Math.max(min, pinchStart.zoom * (dist / pinchStart.dist)));
    $('zoomRange').value = next;
    markZoomPreset(next);
    schedulePinchApply(next);
  }
});

// Pinch mengirim puluhan event per detik; applyConstraints tidak boleh ikut
// sesering itu atau kamera tersendat.
let pinchTimer = null;
function schedulePinchApply(value) {
  clearTimeout(pinchTimer);
  pinchTimer = setTimeout(() => cam.setZoom(value), 90);
}

stage.addEventListener('pointerup', (e) => {
  clearTimeout(pressTimer);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (moved || Date.now() - downAt > 400 || !cam.videoTrack) return;

  // Ketukan saat chrome tersembunyi hanya memunculkannya kembali — supaya
  // "mau lihat tombol" tidak berubah jadi "fokus pindah tanpa sengaja".
  if (body.classList.contains('idle')) return;
  tapFocus(e);
});

stage.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); clearTimeout(pressTimer); });

async function tapFocus(e) {
  const rect = stage.getBoundingClientRect();
  const ring = $('focusRing');
  ring.style.left = `${e.clientX - rect.left}px`;
  ring.style.top = `${e.clientY - rect.top}px`;
  ring.classList.remove('show');
  void ring.offsetWidth;
  ring.classList.add('show');
  setTimeout(() => ring.classList.remove('show'), 1200);
  await cam.focusAt((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  buildPro();
}

async function toggleAeLock() {
  const on = !isPressed('btnAeLock');
  const ok = await cam.setLock(on);
  setPressed('btnAeLock', ok && on);
  buildPro();   // ikut memancarkan state ke panel PC
}

// --- kontrol dock ---------------------------------------------------------

const isPressed = (id) => $(id).getAttribute('aria-pressed') === 'true';
const setPressed = (id, on) => $(id).setAttribute('aria-pressed', String(!!on));

$('btnGo').onclick = async () => {
  if (live) return stop();
  try {
    await openCamera();
  } catch (err) {
    fatal = null;
    $('status').textContent =
      `Gagal buka kamera: ${err.name} — ${err.message}\n\n` +
      'Kalau ini NotAllowedError di halaman https dengan sertifikat self-signed, ' +
      'buka ulang URL dan pilih "Lanjutkan/Advanced".';
    openDrawer(true);
    return;
  }

  // Preferensi mic ikut dipulihkan, tapi baru saat Mulai ditekan: getUserMedia
  // audio butuh gesture pengguna, tidak boleh dipanggil saat halaman dibuka.
  if (prefs.get('mic') && !cam.audioTrack) {
    try { await cam.setMic(true); } catch {}
    setPressed('btnMic', !!cam.audioTrack);
  }

  live = true;
  connectAllViewers();
  $('btnGo').textContent = 'Stop';
  $('btnGo').dataset.live = '1';
  // Layar HP mati = kamera berhenti. Wake lock menahannya.
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  renderLooks();
  syncMonitor();
  syncMeter();
  refreshStatus();
  poke();
};

function stop() {
  live = false;
  tallies.clear();
  recomputeTally();
  tx.removeAll(true);
  cam.stop();
  $('preview').srcObject = null;
  body.classList.remove('has-cam', 'idle', 'blackout');
  wakeLock?.release?.();
  wakeLock = null;
  $('btnGo').textContent = 'Mulai';
  $('btnGo').dataset.live = '0';
  setPressed('btnMic', false);
  overlay.stop();
  meter.stop();
  $('meter').hidden = true;
  body.classList.remove('has-scope');
  buildPro();
  refreshStatus();
}

$('btnPanel').onclick = () => openDrawer(!body.classList.contains('drawer'));
$('scrim').onclick = () => openDrawer(false);

function openDrawer(on) {
  body.classList.toggle('drawer', on);
  setPressed('btnPanel', on);
  if (on) body.classList.remove('idle');
  else poke();
}

$('btnMic').onclick = async () => {
  const on = !isPressed('btnMic');
  try {
    await cam.setMic(on);
  } catch (err) {
    console.warn('mic', err?.name);
    return;
  }
  setPressed('btnMic', on);
  prefs.set('mic', on);
  syncMeter();
  // Track audio disambungkan ke peer yang sudah ada; transceiver-nya sudah
  // dibuat di muka, jadi tidak ada m-line baru dan OBS tidak perlu reload.
  await tx.updateTracks(tracks());
};

$('btnTorch').onclick = async () => {
  const on = !isPressed('btnTorch');
  if (await cam.setTorch(on)) setPressed('btnTorch', on);
  publishState();
};

$('btnAeLock').onclick = () => toggleAeLock();

// Tombol dock menyiklus garis bantu; pilihannya juga ada di tab Monitor.
$('btnGuides').onclick = () => {
  const keys = GUIDE_MODES.map(([v]) => v);
  const next = keys[(keys.indexOf(prefs.get('guides')) + 1) % keys.length];
  prefs.set('guides', next);
  $('guideMode').value = next;
  syncMonitor();
};

// Satu tombol untuk mematikan semua alat monitor sekaligus, lalu memulihkan
// persis susunan terakhir. Saat take dimulai, layar harus bisa langsung bersih.
let scopeMemory = null;
$('btnScope').onclick = () => {
  if (scopesOn()) {
    scopeMemory = { hist: prefs.get('hist'), zebra: prefs.get('zebra'), peak: prefs.get('peak'), falseColor: prefs.get('falseColor') };
    for (const k of ['hist', 'zebra', 'peak']) prefs.set(k, 'off');
    prefs.set('falseColor', false);
  } else {
    const m = scopeMemory ?? { hist: 'luma', zebra: '95', peak: 'off', falseColor: false };
    for (const [k, v] of Object.entries(m)) prefs.set(k, v);
  }
  restoreMonitorSelects();
  syncMonitor();
};

function setBlackout(on) {
  body.classList.toggle('blackout', on);
  // Melepas srcObject menghentikan render preview full-screen sepenuhnya.
  // Track-nya sendiri terus jalan, jadi OBS tidak terganggu sama sekali —
  // yang berhenti hanya pekerjaan menggambarnya ke layar yang memang sengaja
  // digelapkan. Ini penghematan terbesar dari mode ini.
  $('preview').srcObject = on ? null : cam.stream;
  // Keluar dari mode gelap harus mendarat di layar yang ada tombolnya. Tanpa
  // ini, chrome yang sempat menyembunyikan diri selama blackout tetap
  // tersembunyi — dan overlay ikut tetap terjeda.
  if (on) clearTimeout(idleTimer);
  else poke();
  syncPower();
}

$('btnBlackout').onclick = () => setBlackout(true);
// Sengaja ketuk dua kali: satu ketukan tidak boleh membatalkan mode gelap
// kalau HP tergeser di saku atau tersenggol.
$('blackout').addEventListener('dblclick', () => setBlackout(false));
let blackTap = 0;
$('blackout').addEventListener('pointerup', () => {
  const now = Date.now();
  if (now - blackTap < 400) setBlackout(false);
  blackTap = now;
});

// Kunci UI: nyala sekali ketuk, tapi hanya bisa dibuka dengan tekan-tahan.
let lockTimer = null;
$('btnUiLock').addEventListener('pointerdown', () => {
  if (!isPressed('btnUiLock')) return;
  lockTimer = setTimeout(() => {
    body.classList.remove('locked');
    setPressed('btnUiLock', false);
    poke();
  }, 700);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
  $('btnUiLock').addEventListener(ev, () => clearTimeout(lockTimer));
}
$('btnUiLock').onclick = () => {
  if (isPressed('btnUiLock')) return;   // buka kunci lewat tekan-tahan saja
  body.classList.add('locked');
  setPressed('btnUiLock', true);
};

$('btnAutoBrake').onclick = () => {
  const on = !isPressed('btnAutoBrake');
  setPressed('btnAutoBrake', on);
  prefs.set('autoBrake', on);
  if (!on) { brakeStep = 0; tx.setBrake(BRAKE_STEPS[0]); overlay.setInterval(150); }
  refreshStatus();
};

$('btnFit').onclick = () => {
  const on = !isPressed('btnFit');
  setPressed('btnFit', on);
  $('preview').classList.toggle('cover', on);
  prefs.set('fit', on ? 'cover' : 'contain');
  // Kotak gambar berubah -> garis bantu & zebra harus ikut dipetakan ulang.
  overlay.redraw();
};

// Mirror hanya mempengaruhi preview lokal, bukan yang dikirim ke OBS
// (flip di OBS atau lewat ?flip=h — gratis di GPU sana).
$('btnMirror').onclick = () => {
  const on = !isPressed('btnMirror');
  setPressed('btnMirror', on);
  $('preview').classList.toggle('mirror', on);
  prefs.set('mirror', on);
};

// --- tab Monitor ----------------------------------------------------------

function fillSelect(id, options, value) {
  $(id).replaceChildren(
    ...options.map(([v, label]) => Object.assign(document.createElement('option'), { value: v, textContent: label })),
  );
  if (options.some(([v]) => v === value)) $(id).value = value;
}

function restoreMonitorSelects() {
  fillSelect('histMode', HIST_MODES, prefs.get('hist'));
  fillSelect('zebraMode', ZEBRA_LEVELS, prefs.get('zebra'));
  fillSelect('peakMode', PEAK_LEVELS, prefs.get('peak'));
  fillSelect('guideMode', GUIDE_MODES, prefs.get('guides'));
  setPressed('btnFalse', monitorConfig().falseColor);
}

for (const [id, key] of [['histMode', 'hist'], ['zebraMode', 'zebra'], ['peakMode', 'peak'], ['guideMode', 'guides']]) {
  $(id).onchange = () => { prefs.set(key, $(id).value); syncMonitor(); };
}

$('btnFalse').onclick = () => {
  const on = !isPressed('btnFalse');
  setPressed('btnFalse', on);
  prefs.set('falseColor', on);
  syncMonitor();
};

// --- tabs -----------------------------------------------------------------

const TABS = [['tabStream', 'paneStream'], ['tabPro', 'panePro'], ['tabMon', 'paneMon'], ['tabLook', 'paneLook']];

for (const [tab, pane] of TABS) {
  $(tab).onclick = () => {
    for (const [t, p] of TABS) {
      $(t).setAttribute('aria-selected', String(t === tab));
      $(p).classList.toggle('on', p === pane);
    }
    if (pane === 'paneLook') renderLooks();
  };
}

// --- perubahan setelan ----------------------------------------------------

// Ganti kamera/resolusi/fps butuh getUserMedia baru. Sisanya tidak — dan itu
// penting: dulu menekan mic pun me-restart kamera dan menghapus semua setelan.
for (const id of ['cam', 'res', 'fps']) {
  $(id).onchange = async () => {
    prefs.set(id === 'cam' ? 'camId' : id, $(id).value);
    if (!live) return;
    await openCamera();
    await tx.updateTracks(tracks());
  };
}

$('bitrate').onchange = () => { prefs.set('bitrate', $('bitrate').value); tx.updateEncoding(); };
$('degradation').onchange = () => { prefs.set('degradation', $('degradation').value); tx.updateEncoding(); };
$('codec').onchange = () => { prefs.set('codec', $('codec').value); tx.recodec(); };

function syncMeter() {
  const track = cam.audioTrack;
  $('meter').hidden = !track;
  if (track) meter.attach(track);
  else meter.stop();
  // attach() langsung menjalankan loop-nya; syncPower yang memutuskan apakah
  // loop itu boleh hidup sekarang.
  syncPower();
}

// --- baterai --------------------------------------------------------------

navigator.getBattery?.().then((bat) => {
  const show = () => {
    const pct = Math.round(bat.level * 100);
    toggleChip('chipBat', `${bat.charging ? '⚡' : ''}${pct}%`);
    // Di bawah 20% tanpa charger, streaming 1080p60 bisa mati di tengah take.
    $('chipBat').classList.toggle('bad', pct <= 20 && !bat.charging);
  };
  bat.addEventListener('levelchange', show);
  bat.addEventListener('chargingchange', show);
  show();
}).catch(() => {});

// --- init -----------------------------------------------------------------

function restorePrefs() {
  const p = prefs.all();
  for (const [id, key] of [['res', 'res'], ['fps', 'fps'], ['bitrate', 'bitrate'], ['degradation', 'degradation']]) {
    if ([...$(id).options].some((o) => o.value === p[key])) $(id).value = p[key];
  }

  const codecs = videoCodecOptions();
  $('codec').replaceChildren(
    ...codecs.map(([v, label]) => Object.assign(document.createElement('option'), { value: v, textContent: label })),
  );
  if (codecs.some(([v]) => v === p.codec)) $('codec').value = p.codec;

  setPressed('btnFit', p.fit === 'cover');
  $('preview').classList.toggle('cover', p.fit === 'cover');
  setPressed('btnMirror', p.mirror);
  $('preview').classList.toggle('mirror', !!p.mirror);
  setPressed('btnMic', !!p.mic);
  setPressed('btnAutoBrake', p.autoBrake !== false);
  restoreMonitorSelects();
}

restorePrefs();
buildPro();
refreshStatus();
syncMonitor();
refreshCameraList().catch(() => {});

// Wake lock dilepas otomatis saat tab ke background; ambil lagi saat kembali.
document.addEventListener('visibilitychange', async () => {
  syncPower();
  if (document.visibilityState === 'visible' && live && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});
