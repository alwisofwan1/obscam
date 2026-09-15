// Sisi WebRTC milik sender: satu peer per viewer OBS.
//
// Tiga hal yang dulu tidak ada dan paling terasa di produksi:
//   1. start/min bitrate lewat SDP. setParameters() cuma punya maxBitrate;
//      tanpa x-google-start-bitrate Chrome mulai dari ~300 kbps dan butuh
//      belasan detik merangkak ke target. Sepuluh detik pertama tiap koneksi
//      jelek — persis saat orang menekan record.
//   2. renegosiasi. Menyalakan mic saat live dulu tidak pernah sampai ke OBS.
//   3. ICE restart. Peer 'disconnected' dulu langsung dibuang, padahal WiFi
//      yang ngadat sebentar hampir selalu pulih.

import { ICE_CONFIG } from './signal.js';
import { mungeSdp } from './sdp.js';
import { CHANNEL, wrapChannel } from './link.js';

const CODEC_RANK = {
  auto: ['H264', 'VP9', 'VP8', 'AV1'],
  h264: ['H264'],
  vp9: ['VP9'],
  vp8: ['VP8'],
  av1: ['AV1'],
};

export function videoCodecOptions() {
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  const has = (name) => codecs.some((c) => new RegExp(name, 'i').test(c.mimeType));
  return [
    ['auto', 'Auto (H.264 dulu)'],
    ...(has('H264') ? [['h264', 'H.264 — paling murah di OBS']] : []),
    ...(has('VP9') ? [['vp9', 'VP9 — lebih efisien, CPU OBS naik']] : []),
    ...(has('AV1') ? [['av1', 'AV1 — eksperimental']] : []),
    ...(has('VP8') ? [['vp8', 'VP8 — paling kompatibel']] : []),
  ];
}

// --- peer ------------------------------------------------------------------

export function createTransport({ signal, getConfig, onChange, onMessage }) {
  /** @type {Map<string, any>} */
  const peers = new Map();
  let stats = null;

  // Rem encoder. scaleResolutionDownBy dan maxFramerate bekerja lewat
  // setParameters — encoder menerima frame yang lebih kecil/jarang tanpa
  // getUserMedia disentuh. Itu pentingnya: menurunkan resolusi lewat
  // constraint berarti me-restart kamera, dan me-restart kamera di tengah
  // take berarti framing bergeser dan semua setelan pro hilang.
  let brake = { scale: 1, fps: 0 };

  function preferCodec(transceiver, mode) {
    if (!transceiver?.setCodecPreferences || !RTCRtpSender.getCapabilities) return;
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
    if (!codecs.length) return;
    const order = CODEC_RANK[mode] ?? CODEC_RANK.auto;
    const rank = (c) => {
      const i = order.findIndex((n) => new RegExp(n, 'i').test(c.mimeType));
      return i < 0 ? order.length : i;
    };
    // Untuk pilihan eksplisit, codec lain tetap disertakan di belakang sebagai
    // jaring pengaman — lebih baik jatuh ke VP8 daripada tidak ada gambar.
    try {
      transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
    } catch {}
  }

  async function applyEncoding(p) {
    const { bitrate, degradation } = getConfig();
    const params = p.videoSender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    const e = params.encodings[0];
    e.maxBitrate = Number(bitrate);
    e.scaleResolutionDownBy = brake.scale;
    if (brake.fps > 0) e.maxFramerate = brake.fps;
    else delete e.maxFramerate;
    params.degradationPreference = degradation;
    await p.videoSender.setParameters(params).catch(() => {});
  }

  /** @param {{scale:number, fps:number}} next */
  async function setBrake(next) {
    if (next.scale === brake.scale && next.fps === brake.fps) return;
    brake = next;
    await updateEncoding();
  }

  async function negotiate(p) {
    if (p.negotiating) { p.pending = true; return; }
    p.negotiating = true;
    try {
      do {
        p.pending = false;
        const offer = await p.pc.createOffer(p.iceRestart ? { iceRestart: true } : undefined);
        p.iceRestart = false;
        offer.sdp = mungeSdp(offer.sdp, { maxBitrate: Number(getConfig().bitrate) });
        await p.pc.setLocalDescription(offer);
        await applyEncoding(p);
        signal(p.id, { sdp: p.pc.localDescription });
      } while (p.pending);
    } catch (err) {
      console.warn('negotiate', err?.name ?? err);
    } finally {
      p.negotiating = false;
    }
  }

  function add(viewerId, tracks) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    const p = { id: viewerId, pc, negotiating: false, pending: false, iceRestart: false, state: 'new' };

    // Transceiver dibuat di muka supaya menyalakan mic di tengah siaran tidak
    // menambah m-line baru — arah paling umum renegosiasi jadi hilang total.
    p.videoTx = pc.addTransceiver('video', { direction: 'sendonly' });
    p.audioTx = pc.addTransceiver('audio', { direction: 'sendonly' });
    p.videoSender = p.videoTx.sender;
    p.audioSender = p.audioTx.sender;
    preferCodec(p.videoTx, getConfig().codec);

    // Kanal kontrol: tally dari OBS, dan perintah kamera dari halaman /control.
    // Dibuat di sisi sender karena sender selalu yang membuat offer.
    p.link = wrapChannel(
      pc.createDataChannel(CHANNEL, { ordered: true }),
      (msg) => onMessage?.(viewerId, msg),
    );

    pc.onicecandidate = (e) => {
      if (e.candidate) signal(viewerId, { candidate: e.candidate });
    };
    pc.onnegotiationneeded = () => negotiate(p);
    pc.oniceconnectionstatechange = () => {
      // 'disconnected' hampir selalu WiFi yang ngadat sebentar. ICE restart
      // memulihkannya tanpa OBS sempat balik ke layar tunggu.
      if (pc.iceConnectionState === 'disconnected') {
        clearTimeout(p.restartTimer);
        p.restartTimer = setTimeout(() => {
          if (pc.iceConnectionState !== 'disconnected') return;
          p.iceRestart = true;
          negotiate(p);
        }, 1500);
      }
      if (pc.iceConnectionState === 'connected') clearTimeout(p.restartTimer);
    };
    pc.onconnectionstatechange = () => {
      p.state = pc.connectionState;
      if (['failed', 'closed'].includes(pc.connectionState)) remove(viewerId);
      onChange?.();
    };

    peers.set(viewerId, p);
    setTracks(p, tracks);
    return p;
  }

  async function setTracks(p, { video, audio }) {
    await p.videoSender.replaceTrack(video ?? null).catch(() => {});
    await p.audioSender.replaceTrack(audio ?? null).catch(() => {});
    await applyEncoding(p);
  }

  async function updateTracks(tracks) {
    for (const p of peers.values()) await setTracks(p, tracks);
  }

  async function updateEncoding() {
    for (const p of peers.values()) await applyEncoding(p);
  }

  function recodec() {
    // setCodecPreferences hanya berlaku saat negosiasi berikutnya.
    for (const p of peers.values()) {
      preferCodec(p.videoTx, getConfig().codec);
      negotiate(p);
    }
  }

  async function onSignal(from, data) {
    const p = peers.get(from);
    if (!p) return;
    try {
      if (data.sdp) await p.pc.setRemoteDescription(data.sdp);
      if (data.candidate) await p.pc.addIceCandidate(data.candidate).catch(() => {});
    } catch (err) {
      console.warn('onSignal', err?.name ?? err);
    }
  }

  function remove(viewerId, notify = false) {
    const p = peers.get(viewerId);
    if (!p) return;
    // ICE butuh puluhan detik untuk sadar peer hilang, jadi kabari eksplisit
    // supaya OBS langsung balik ke layar tunggu.
    if (notify) signal(viewerId, { bye: true });
    p.link?.close();
    clearTimeout(p.restartTimer);
    p.pc.close();
    peers.delete(viewerId);
    onChange?.();
  }

  function removeAll(notify = false) {
    [...peers.keys()].forEach((id) => remove(id, notify));
  }

  // --- telemetri -----------------------------------------------------------
  // Tanpa ini tidak ada cara tahu bitrate yang benar-benar mengalir, apakah
  // encoder-nya hardware, atau apakah gambar turun karena CPU atau WiFi.

  let prev = null;

  async function sampleStats() {
    const p = peers.values().next().value;
    if (!p) { stats = null; return null; }

    let out = null;
    let remote = null;
    let pair = null;
    const report = await p.pc.getStats().catch(() => null);
    if (!report) return null;

    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
      else if (s.type === 'remote-inbound-rtp' && s.kind === 'video') remote = s;
      else if (s.type === 'candidate-pair' && s.nominated) pair = s;
    });
    if (!out) return null;

    const dt = prev ? (out.timestamp - prev.timestamp) / 1000 : 0;
    const kbps = dt > 0 ? ((out.bytesSent - prev.bytesSent) * 8) / dt / 1000 : 0;
    const lossDelta = remote && prev?.packetsLost != null
      ? remote.packetsLost - prev.packetsLost
      : 0;
    const sentDelta = prev ? out.packetsSent - prev.packetsSent : 0;

    stats = {
      kbps: Math.round(kbps),
      fps: Math.round(out.framesPerSecond ?? 0),
      width: out.frameWidth ?? 0,
      height: out.frameHeight ?? 0,
      rtt: Math.round((remote?.roundTripTime ?? pair?.currentRoundTripTime ?? 0) * 1000),
      loss: sentDelta > 0 ? Math.max(0, (lossDelta / (sentDelta + lossDelta)) * 100) : 0,
      jitter: Math.round((remote?.jitter ?? 0) * 1000),
      limit: out.qualityLimitationReason ?? 'none',
      encoder: out.encoderImplementation ?? '',
      // Encoder software di HP = baterai panas dan fps jatuh di 1080p60.
      hardware: /hardware|mediacodec|videotoolbox|qcom|exynos/i.test(out.encoderImplementation ?? ''),
      available: Math.round((pair?.availableOutgoingBitrate ?? 0) / 1000),
    };
    prev = { timestamp: out.timestamp, bytesSent: out.bytesSent, packetsSent: out.packetsSent, packetsLost: remote?.packetsLost ?? 0 };
    return stats;
  }

  /** Kirim ke satu viewer, atau ke semuanya kalau id dikosongkan. */
  function post(msg, viewerId = null) {
    if (viewerId) return peers.get(viewerId)?.link?.send(msg);
    for (const p of peers.values()) p.link?.send(msg);
  }

  return {
    add,
    remove,
    removeAll,
    post,
    setBrake,
    get brake() { return brake; },
    updateTracks,
    updateEncoding,
    recodec,
    onSignal,
    sampleStats,
    has: (id) => peers.has(id),
    ids: () => [...peers.keys()],
    get size() { return peers.size; },
    get connected() { return [...peers.values()].filter((p) => p.state === 'connected').length; },
    get stats() { return stats; },
  };
}
