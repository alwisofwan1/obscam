import { connectSignal, ICE_CONFIG } from './signal.js';
import { wrapChannel } from './link.js';

const $ = (id) => document.getElementById(id);
const v = $('v');
const hud = $('hud');

const params = new URL(location).searchParams;
const room = params.get('room') || 'default';
$('r').textContent = room;
if (params.get('nohud') === '1') hud.classList.add('hide');
if (params.get('fit')) v.style.objectFit = params.get('fit'); // contain|cover|fill

// Latency buffer. Default Chrome menahan ratusan milidetik untuk menyerap
// jitter; di LAN itu murni delay yang terbuang. Bisa dinaikkan lewat
// ?buffer=<ms> kalau WiFi-nya memang berisik.
const TARGET_BUFFER = Number(params.get('buffer') ?? 0);

// Rotasi/flip dilakukan di sini supaya tidak membebani encoder HP.
const rotate = Number(params.get('rotate') ?? 0);
const flip = params.get('flip'); // h | v | hv
if (rotate || flip) {
  const t = [];
  if (rotate) t.push(`rotate(${rotate}deg)`);
  if (flip?.includes('h')) t.push('scaleX(-1)');
  if (flip?.includes('v')) t.push('scaleY(-1)');
  v.style.transform = t.join(' ');
  // Rotasi ganjil menukar sisi panjang/pendek; tanpa ini gambar terpotong.
  if (rotate % 180 !== 0) v.classList.add('rot');
}

let pc = null;
let ms = null;
let senderId = null;
let muteTimer = null;
let link = null;

function reset() {
  clearTimeout(muteTimer);
  pc?.close();
  pc = null;
  ms = null;
  link = null;
  v.srcObject = null;
  if (params.get('nohud') !== '1') hud.classList.remove('hide');
}

function lowLatency(receiver) {
  try {
    // jitterBufferTarget adalah nama standarnya; CEF/Chrome lama masih memakai
    // playoutDelayHint (detik). Pasang keduanya, yang tidak dikenal diabaikan.
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = TARGET_BUFFER;
    if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = TARGET_BUFFER / 1000;
  } catch {}
}

function newPeer(sid, sig) {
  pc?.close();
  pc = new RTCPeerConnection(ICE_CONFIG);
  // Stream dirakit di sisi ini, bukan diambil dari e.streams[0]: sender memakai
  // addTransceiver() tanpa MediaStream, jadi SDP-nya tidak membawa msid dan
  // e.streams datang kosong. Merakit sendiri juga membuat halaman ini tahan
  // terhadap sender mana pun, dengan msid atau tanpa.
  ms = new MediaStream();

  pc.ontrack = (e) => {
    lowLatency(e.receiver);
    ms.addTrack(e.track);
    if (v.srcObject !== ms) v.srcObject = ms;

    if (e.track.kind === 'video') {
      // onmute juga menyala saat WiFi tersendat sedetik. Dulu itu langsung
      // melempar OBS balik ke layar tunggu — berkedip di tengah siaran.
      // Beri waktu pulih dulu.
      e.track.onmute = () => {
        clearTimeout(muteTimer);
        muteTimer = setTimeout(() => { if (e.track.muted) reset(); }, 2500);
      };
      e.track.onunmute = () => clearTimeout(muteTimer);
    }

    // OBS Browser Source mengizinkan autoplay + audio; di browser biasa
    // play() bisa ditolak sampai ada interaksi user.
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    hud.classList.add('hide');
  };
  // Sender yang membuat kanalnya; di sini tinggal menerima.
  pc.ondatachannel = (e) => {
    link = wrapChannel(e.channel, () => {});
    link.send({ type: 'hello', role: 'obs' });
    sendTally();
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) sig.signal(sid, { candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) reset();
  };
  return pc;
}

// --- tally ----------------------------------------------------------------
//
// Halaman ini tahu kapan source-nya on-air; HP tidak. Tanpa jalur balik, orang
// di balik kamera tidak punya cara tahu dia sedang disiarkan — dan itu
// perlengkapan standar di setiap kamera broadcast.
//
// obs-browser mengirim event ini ke window. `active` = dipakai scene yang
// sedang program; `visible` = terlihat di scene mana pun (mis. preview saat
// studio mode). Keduanya jalan di control level default.

const tally = { program: false, preview: false, streaming: false, recording: false };

function sendTally() {
  link?.send({ type: 'tally', ...tally });
}

function bindObs() {
  const on = (name, fn) => window.addEventListener(name, fn);

  on('obsSourceActiveChanged', (e) => { tally.program = !!e.detail?.active; sendTally(); });
  on('obsSourceVisibleChanged', (e) => { tally.preview = !!e.detail?.visible; sendTally(); });
  on('obsStreamingStarted', () => { tally.streaming = true; sendTally(); });
  on('obsStreamingStopped', () => { tally.streaming = false; sendTally(); });
  on('obsRecordingStarted', () => { tally.recording = true; sendTally(); });
  on('obsRecordingStopped', () => { tally.recording = false; sendTally(); });

  // getStatus() butuh control level READ_OBS di properti Browser Source. Kalau
  // tidak diberikan, event di atas tetap jalan — cuma status streaming/recording
  // yang tidak terisi sampai ada perubahan.
  try {
    window.obsstudio?.getStatus?.((s) => {
      tally.streaming = !!s?.streaming;
      tally.recording = !!s?.recording;
      sendTally();
    });
  } catch {}
}

if (window.obsstudio) bindObs();

// Di luar OBS (uji di browser biasa) tally bisa dipaksa lewat query, supaya
// jalurnya bisa diverifikasi tanpa menjalankan OBS.
const forced = params.get('tally');
if (forced) {
  tally.program = forced === 'program';
  tally.preview = forced === 'preview' || forced === 'program';
}

const sig = connectSignal({
  room,
  role: 'viewer',
  // Viewer pasif: sender yang bikin offer begitu tahu ada viewer.
  onWelcome: () => reset(),
  onError: (reason) => {
    // Halaman OBS tidak punya UI; tulis alasannya ke HUD supaya ketahuan
    // tanpa harus buka devtools Browser Source.
    hud.classList.remove('hide');
    hud.replaceChildren(
      Object.assign(document.createElement('b'), { textContent: 'Ditolak server' }),
      Object.assign(document.createElement('span'), { textContent: reason }),
      Object.assign(document.createElement('span'), {
        textContent: 'Pakai URL lengkap dari terminal PC (ada ?k=...).',
      }),
    );
  },
  onPeerLeave: ({ id }) => { if (id === senderId) reset(); },
  onSignal: async (from, data) => {
    if (data.sdp?.type === 'offer') {
      // Offer susulan (mic dinyalakan, codec diganti, ICE restart) harus
      // dijawab di peer yang SAMA. Bikin peer baru tiap offer = renegosiasi
      // tidak pernah berhasil.
      const fresh = from !== senderId || !pc || pc.connectionState === 'closed';
      senderId = from;
      const p = fresh ? newPeer(from, sig) : pc;
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
