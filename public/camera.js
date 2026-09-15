// Lapisan kamera: getUserMedia, kapabilitas, dan penerapan constraint.
//
// Tanggung jawab utama modul ini adalah hal yang dulu salah: kontrol manual
// (ISO, shutter, jarak fokus, suhu warna) TIDAK BOLEH dikirim selagi mode-nya
// masih otomatis. Chrome menolaknya tanpa bunyi, jadi UI-nya kelihatan jalan
// padahal tidak. Di sini setiap nilai manual digerbangi mode-nya dulu, dan
// hasilnya selalu dibaca ulang lewat getSettings() — bukan diasumsikan.

// Nilai manual -> (mode yang mengendalikannya, nilai mode yang dibutuhkan).
const GATES = {
  exposureTime: ['exposureMode', 'manual'],
  iso: ['exposureMode', 'manual'],
  focusDistance: ['focusMode', 'manual'],
  colorTemperature: ['whiteBalanceMode', 'manual'],
};

// Urutan tampil panel pro: mode dulu, lalu nilai yang digerbanginya.
export const PRO_SPEC = [
  ['exposureMode', 'Eksposur', null, 'mode'],
  ['exposureCompensation', 'Exp. comp', (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))],
  ['exposureTime', 'Shutter', (v) => `1/${Math.max(1, Math.round(10000 / Math.max(v, 0.01)))}`],
  ['iso', 'ISO', (v) => `${Math.round(v)}`],
  ['focusMode', 'Fokus', null, 'mode'],
  ['focusDistance', 'Jarak fokus', (v) => v.toFixed(2)],
  ['whiteBalanceMode', 'White bal.', null, 'mode'],
  ['colorTemperature', 'Suhu warna', (v) => `${Math.round(v)}K`],
  ['brightness', 'Brightness'],
  ['contrast', 'Kontras'],
  ['saturation', 'Saturasi'],
  ['sharpness', 'Ketajaman'],
];

// Preset Kelvin ala kamera beneran — jauh lebih berguna daripada slider mentah.
export const KELVIN_PRESETS = [
  [2800, 'Lampu pijar'],
  [3200, 'Tungsten'],
  [4300, 'Neon'],
  [5600, 'Siang'],
  [6500, 'Mendung'],
];

export function createCamera() {
  let stream = null;
  let videoTrack = null;
  let audioTrack = null;
  let caps = {};

  const supported = (() => {
    try {
      return navigator.mediaDevices.getSupportedConstraints?.() ?? {};
    } catch {
      return {};
    }
  })();

  const listeners = { change: [] };
  const emit = () => listeners.change.forEach((fn) => fn());

  async function listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Kamera ${i + 1}` }));
  }

  /** Buka/ganti kamera. Audio diurus terpisah oleh setMic(). */
  async function open({ deviceId, width, height, frameRate }) {
    const next = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: frameRate },
      },
      audio: false,
    });

    const vt = next.getVideoTracks()[0];
    // Beri tahu encoder ini video gerak, bukan slideshow — memengaruhi
    // keputusan rate control saat bandwidth turun.
    if (vt) vt.contentHint = 'motion';

    // Track video lama dihentikan, track audio yang sedang jalan dipertahankan
    // supaya ganti resolusi tidak memutus mic.
    videoTrack?.stop();
    videoTrack = vt;
    // Lensa baru = kapabilitas dan mode baru; niat lensa lama tidak berlaku.
    for (const k of Object.keys(intent)) delete intent[k];
    for (const k of Object.keys(reported)) delete reported[k];

    stream = new MediaStream([vt, ...(audioTrack ? [audioTrack] : [])]);
    caps = vt?.getCapabilities?.() ?? {};

    // Android kadang membunuh kamera saat app lain merebutnya.
    vt.addEventListener('ended', () => {
      videoTrack = null;
      emit();
    });

    emit();
    return vt;
  }

  /**
   * Nyalakan/matikan mic TANPA menyentuh track video.
   * Dulu ini memanggil ulang openCamera() — framing bergeser dan semua kontrol
   * pro balik ke auto hanya karena menekan tombol mic.
   */
  async function setMic(on) {
    if (on && !audioTrack) {
      const a = await navigator.mediaDevices.getUserMedia({
        // Semua pemrosesan dimatikan: ini sumber produksi, bukan panggilan
        // video. AGC/NS merusak audio yang nanti di-mix di OBS.
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
      audioTrack = a.getAudioTracks()[0] ?? null;
      // Izin mic bisa diberikan tapi tidak menghasilkan track (device sibuk,
      // atau stub di test). Jangan sampai itu melempar dan mematikan UI.
      if (!audioTrack) return null;
      audioTrack.contentHint = 'music';
      stream?.addTrack(audioTrack);
    } else if (!on && audioTrack) {
      stream?.removeTrack(audioTrack);
      audioTrack.stop();
      audioTrack = null;
    }
    emit();
    return audioTrack;
  }

  function stop() {
    videoTrack?.stop();
    audioTrack?.stop();
    videoTrack = null;
    audioTrack = null;
    stream = null;
    caps = {};
    emit();
  }

  // --- constraint -----------------------------------------------------------
  //
  // Tiga hal yang membuat kontrol manual gagal diam-diam di HP asli, dan
  // ketiganya ditangani di sini:
  //
  //   1. applyConstraints({advanced:[...]}) tidak pernah melempar. Kalau HP
  //      menolak, tidak ada apa pun yang memberi tahu. Constraint biasa
  //      (non-advanced) MELEMPAR OverconstrainedError — jadi itu dicoba dulu,
  //      supaya penolakan sungguhan terlihat, baru jatuh ke advanced.
  //   2. Perpindahan mode butuh waktu. Satu frame tidak cukup di HP asli;
  //      getSettings() masih melaporkan mode lama. Jadi di-poll, bukan ditunggu
  //      sekali dengan durasi tebakan.
  //   3. Sebagian HP TIDAK PERNAH melaporkan exposureMode/focusMode/
  //      whiteBalanceMode di getSettings(), walau modenya ada di
  //      getCapabilities() dan benar-benar berpindah. Menggerbangi slider pada
  //      echo yang tidak pernah datang = slider mati selamanya. Karena itu
  //      niat kita sendiri disimpan dan dipakai saat HP memang tidak melapor.

  const MODE_KEYS = ['exposureMode', 'focusMode', 'whiteBalanceMode'];

  /** Mode yang kita minta dan berhasil diterapkan, untuk HP yang tidak melapor. */
  const intent = {};
  /** Apakah HP ini melaporkan key tersebut di getSettings() sama sekali. */
  const reported = {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function applyRaw(key, value) {
    if (!videoTrack) return { ok: false, error: 'no-track' };
    // Constraint biasa: satu-satunya bentuk yang melempar saat ditolak.
    try {
      await videoTrack.applyConstraints({ [key]: value });
      return { ok: true };
    } catch (err) {
      if (err?.name !== 'OverconstrainedError' && err?.name !== 'TypeError') {
        console.warn('applyConstraints', key, err?.name ?? err);
      }
    }
    // Sebagian build Chrome hanya menerima kontrol kamera lewat `advanced`.
    try {
      await videoTrack.applyConstraints({ advanced: [{ [key]: value }] });
      return { ok: true };
    } catch (err) {
      console.warn('applyConstraints advanced', key, err?.name ?? err);
      return { ok: false, error: err?.name ?? 'rejected' };
    }
  }

  /**
   * Tunggu sampai getSettings() benar-benar melaporkan nilainya.
   * Mengembalikan 'ok', 'silent' (HP tidak melaporkan key ini sama sekali),
   * atau 'timeout' (dilaporkan, tapi tidak pernah berubah = ditolak).
   */
  async function confirm(key, value, timeout = 900) {
    // Sekali ketahuan HP ini tidak melaporkan key tersebut, jangan menunggu
    // lama lagi: setiap perpindahan mode berikutnya akan membuat UI diam
    // hampir satu detik menunggu jawaban yang memang tidak pernah ada.
    if (reported[key] === false) timeout = 150;
    const deadline = Date.now() + timeout;
    let sawKey = false;
    while (Date.now() < deadline) {
      const s = videoTrack?.getSettings?.() ?? {};
      if (key in s) {
        sawKey = true;
        reported[key] = true;
        if (s[key] === value) return 'ok';
      }
      await sleep(70);
    }
    reported[key] = sawKey;
    return sawKey ? 'timeout' : 'silent';
  }

  /** Mode efektif: laporan HP kalau ada, kalau tidak pakai niat kita sendiri. */
  function modeOf(key) {
    const s = videoTrack?.getSettings?.() ?? {};
    if (key in s) return s[key];
    return intent[key] ?? null;
  }

  /** Pindah mode. Mengembalikan true kalau boleh dianggap berlaku. */
  async function setMode(key, value) {
    if (!(caps[key] ?? []).includes(value)) return false;
    const { ok } = await applyRaw(key, value);
    if (!ok) return false;
    const state = await confirm(key, value);
    // 'silent' = HP tidak pernah melapor. Tidak ada cara memverifikasi, dan
    // applyConstraints tidak menolak — jadi diperlakukan berlaku.
    if (state === 'ok' || state === 'silent') {
      intent[key] = value;
      emit();
      return true;
    }
    return false;
  }

  /**
   * Terapkan satu nilai pro, lengkap dengan gerbang mode-nya.
   * Mengembalikan nilai yang BENAR-BENAR berlaku menurut getSettings(), karena
   * HP sering meng-clamp ke nilai terdekat yang didukung.
   */
  async function apply(key, value) {
    if (!videoTrack) return null;

    const gate = GATES[key];
    if (gate) {
      const [modeKey, needed] = gate;
      if (modeOf(modeKey) !== needed && !(await setMode(modeKey, needed))) return null;
    }

    await applyRaw(key, value);
    await confirm(key, value, 400);
    const s = videoTrack?.getSettings?.() ?? {};
    // HP yang tidak melaporkan nilainya: pakai angka yang kita minta, jangan
    // kembalikan null — UI akan mengira penerapannya gagal.
    return key in s ? s[key] : value;
  }

  /** Tap-to-focus / tap-to-expose. Koordinat 0..1 relatif frame. */
  async function focusAt(x, y) {
    if (!supported.pointsOfInterest || !videoTrack) return false;
    const poi = [{ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }];
    // single-shot kalau ada: itu yang membuat "tap lalu terkunci" terasa
    // seperti aplikasi kamera bawaan, bukan fokus yang terus berburu.
    const modes = caps.focusMode ?? [];
    if (modes.includes('single-shot')) await setMode('focusMode', 'single-shot');
    else if (modes.includes('continuous')) await setMode('focusMode', 'continuous');
    return (await applyRaw('pointsOfInterest', poi)).ok;
  }

  /**
   * Kunci eksposur + fokus + white balance pada nilai saat ini.
   * Ini yang mencegah gambar "pumping" tiap ada orang lewat di depan lensa —
   * satu-satunya kontrol yang paling sering dicari saat rekaman serius.
   */
  async function setLock(on) {
    const pairs = [
      ['exposureMode', on ? ['manual', 'single-shot'] : ['continuous']],
      ['focusMode', on ? ['manual', 'single-shot'] : ['continuous']],
      ['whiteBalanceMode', on ? ['manual', 'single-shot'] : ['continuous']],
    ];
    let applied = 0;
    for (const [key, wanted] of pairs) {
      const avail = caps[key] ?? [];
      const pick = wanted.find((m) => avail.includes(m));
      if (pick) applied += (await setMode(key, pick)) ? 1 : 0;
    }
    emit();
    return applied > 0;
  }

  async function setTorch(on) {
    if (!caps.torch) return false;
    return applyRaw('torch', on);
  }

  async function setZoom(z) {
    if (!caps.zoom) return null;
    const { min, max } = caps.zoom;
    return apply('zoom', Math.min(max, Math.max(min, z)));
  }

  async function resetAuto() {
    for (const key of MODE_KEYS) {
      if ((caps[key] ?? []).includes('continuous')) await setMode(key, 'continuous');
    }
    if (caps.zoom) await applyRaw('zoom', caps.zoom.min);
    if (caps.exposureCompensation) await applyRaw('exposureCompensation', 0);
    emit();
  }

  /** Snapshot semua kontrol pro yang sedang berlaku — untuk disimpan jadi Look. */
  function snapshot() {
    const s = videoTrack?.getSettings?.() ?? {};
    const out = {};
    for (const [key] of PRO_SPEC) {
      const v = MODE_KEYS.includes(key) ? modeOf(key) : s[key];
      if (v != null && caps[key]) out[key] = v;
    }
    if (caps.zoom && s.zoom != null) out.zoom = s.zoom;
    return out;
  }

  /** Terapkan Look. Mode dulu, baru nilainya — urutannya penting. */
  async function applyLook(look) {
    for (const key of MODE_KEYS) if (look[key] != null) await setMode(key, look[key]);
    for (const [key, value] of Object.entries(look)) {
      if (MODE_KEYS.includes(key)) continue;
      await apply(key, value);
    }
    emit();
  }

  return {
    listCameras,
    open,
    setMic,
    stop,
    apply,
    focusAt,
    setLock,
    setTorch,
    setZoom,
    resetAuto,
    snapshot,
    applyLook,
    setMode,
    modeOf,
    // Untuk baris diagnostik di panel: HP mana yang meng-echo settings-nya.
    silentModes: () => MODE_KEYS.filter((k) => caps[k] && !(k in (videoTrack?.getSettings?.() ?? {}))),
    onChange: (fn) => listeners.change.push(fn),
    get stream() { return stream; },
    get videoTrack() { return videoTrack; },
    get audioTrack() { return audioTrack; },
    get caps() { return caps; },
    get settings() { return videoTrack?.getSettings?.() ?? {}; },
    get supportsPoi() { return !!supported.pointsOfInterest; },
    get deviceId() { return videoTrack?.getSettings?.().deviceId ?? ''; },
  };
}
