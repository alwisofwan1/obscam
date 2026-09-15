// Alat monitor kelas broadcast: histogram, zebra, focus peaking, false color,
// dan garis bantu.
//
// Semuanya digambar dari SATU sampel kecil (256×144) yang diambil dari elemen
// <video> preview tiap ~150 ms. Bukan dari stream yang dikirim — overlay ini
// murni lokal dan tidak pernah ikut ke OBS.
//
// Kenapa satu sampel: getImageData mahal. Satu pengambilan 36 ribu piksel
// memberi makan seluruh alat di bawah ini sekaligus, dan biayanya tetap rata
// walau semuanya dinyalakan bersamaan.

const SAMPLE_W = 256;
const SAMPLE_H = 144;

// Ambang zebra dalam IRE (0–100). 95 = highlight nyaris gosong, 100 = benar
// benar clipping. Kulit manusia yang ter-ekspos benar ada di 60–70.
export const ZEBRA_LEVELS = [
  ['off', 'Mati'],
  ['70', '70 — kulit'],
  ['95', '95 — hampir gosong'],
  ['100', '100 — clipping'],
];

export const PEAK_LEVELS = [
  ['off', 'Mati'],
  ['low', 'Halus'],
  ['high', 'Sensitif'],
];

export const HIST_MODES = [
  ['off', 'Mati'],
  ['luma', 'Luma'],
  ['rgb', 'RGB'],
];

export const GUIDE_MODES = [
  ['off', 'Mati'],
  ['thirds', 'Rule of thirds'],
  ['thirds+safe', 'Thirds + title-safe'],
];

const PEAK_THRESHOLD = { low: 60, high: 26 };

/**
 * Kotak tempat gambar BENAR-BENAR tergambar di dalam elemen video.
 * object-fit: contain menyisakan pilar hitam; menggambar garis bantu di atas
 * pilar itu membuat rule of thirds meleset dari framing yang sebenarnya.
 */
export function contentRect(video, w, h, fit) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0, w, h };
  const scale = fit === 'cover'
    ? Math.max(w / vw, h / vh)
    : Math.min(w / vw, h / vh);
  const cw = vw * scale;
  const ch = vh * scale;
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}

export function createOverlay({ video, canvas, scope, getConfig }) {
  const sample = Object.assign(document.createElement('canvas'), { width: SAMPLE_W, height: SAMPLE_H });
  const sctx = sample.getContext('2d', { willReadFrequently: true });
  const mask = Object.assign(document.createElement('canvas'), { width: SAMPLE_W, height: SAMPLE_H });
  const mctx = mask.getContext('2d');

  const hist = { r: new Uint32Array(64), g: new Uint32Array(64), b: new Uint32Array(64), y: new Uint32Array(64) };
  let timer = null;
  let dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [canvas, scope]) {
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
    }
  }

  // --- satu lintasan piksel untuk semua alat -------------------------------

  function analyse(cfg) {
    let data;
    try {
      sctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
      data = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
    } catch {
      return null; // frame belum ada, atau tainted
    }
    const px = data.data;

    for (const k of ['r', 'g', 'b', 'y']) hist[k].fill(0);

    const wantHist = cfg.hist !== 'off';
    const wantZebra = cfg.zebra !== 'off';
    const wantPeak = cfg.peak !== 'off';
    const wantFalse = cfg.falseColor;
    const zebraCut = wantZebra ? (Number(cfg.zebra) / 100) * 255 : 999;
    const peakCut = PEAK_THRESHOLD[cfg.peak] ?? 999;

    // Luma disimpan terpisah: focus peaking butuh membandingkan tetangga, dan
    // menghitung ulang luma per tetangga akan melipatgandakan kerjanya.
    const luma = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      const r = px[p], g = px[p + 1], b = px[p + 2];
      const y = (r * 77 + g * 150 + b * 29) >> 8;
      luma[i] = y;
      if (wantHist) {
        hist.y[y >> 2]++;
        hist.r[r >> 2]++;
        hist.g[g >> 2]++;
        hist.b[b >> 2]++;
      }
    }

    if (!wantZebra && !wantPeak && !wantFalse) return null;

    const out = mctx.createImageData(SAMPLE_W, SAMPLE_H);
    const o = out.data;

    for (let y = 0; y < SAMPLE_H; y++) {
      for (let x = 0; x < SAMPLE_W; x++) {
        const i = y * SAMPLE_W + x;
        const p = i * 4;
        const v = luma[i];

        if (wantFalse) {
          const c = falseColor(v);
          o[p] = c[0]; o[p + 1] = c[1]; o[p + 2] = c[2]; o[p + 3] = 190;
          continue;
        }

        // Focus peaking: beda luma dengan tetangga kanan & bawah. Cukup untuk
        // menandai tepi tajam, dan jauh lebih murah dari Sobel penuh.
        if (wantPeak && x < SAMPLE_W - 1 && y < SAMPLE_H - 1) {
          const edge = Math.abs(v - luma[i + 1]) + Math.abs(v - luma[i + SAMPLE_W]);
          if (edge > peakCut) {
            o[p] = 255; o[p + 1] = 45; o[p + 2] = 85; o[p + 3] = 235;
            continue;
          }
        }

        // Zebra: garis diagonal, bukan blok penuh — supaya gambar di bawahnya
        // masih terbaca. Persis kelakuan zebra di kamera broadcast.
        if (wantZebra && v >= zebraCut && ((x + y) & 7) < 4) {
          o[p] = 255; o[p + 1] = 255; o[p + 2] = 255; o[p + 3] = 200;
        }
      }
    }
    return out;
  }

  // Skala eksposur ala false color: biru = gelap/noise, hijau = kulit yang
  // benar, merah = clipping.
  function falseColor(v) {
    if (v < 12) return [40, 60, 220];
    if (v < 45) return [40, 140, 220];
    if (v < 110) return [80, 80, 80];
    if (v < 160) return [60, 210, 90];
    if (v < 205) return [230, 210, 60];
    if (v < 245) return [235, 140, 40];
    return [235, 40, 40];
  }

  // --- menggambar -----------------------------------------------------------

  function drawGuides(g, rect, mode) {
    if (mode === 'off') return;
    const { x, y, w, h } = rect;
    g.lineWidth = Math.max(1, dpr);
    g.strokeStyle = 'rgba(255,255,255,.34)';
    for (let i = 1; i < 3; i++) {
      g.beginPath();
      g.moveTo(x + (w * i) / 3, y); g.lineTo(x + (w * i) / 3, y + h);
      g.moveTo(x, y + (h * i) / 3); g.lineTo(x + w, y + (h * i) / 3);
      g.stroke();
    }
    // Silang tengah — patokan tercepat untuk meluruskan tripod.
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = 12 * dpr;
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.beginPath();
    g.moveTo(cx - r, cy); g.lineTo(cx + r, cy);
    g.moveTo(cx, cy - r); g.lineTo(cx, cy + r);
    g.stroke();

    if (mode === 'thirds+safe') {
      // Title safe 90% — margin aman kalau hasilnya nanti dipotong/di-overlay.
      g.strokeStyle = 'rgba(255,210,80,.45)';
      g.setLineDash([6 * dpr, 6 * dpr]);
      g.strokeRect(x + w * 0.05, y + h * 0.05, w * 0.9, h * 0.9);
      g.setLineDash([]);
    }
  }

  function drawHistogram(cfg) {
    const g = scope.getContext('2d');
    g.clearRect(0, 0, scope.width, scope.height);
    if (cfg.hist === 'off') return;

    const W = scope.width;
    const H = scope.height;
    // Cukup pekat: histogram sering menumpuk di atas bagian gambar yang terang,
    // dan bar tipis hilang total di latar setengah transparan.
    g.fillStyle = 'rgba(6,8,12,.86)';
    g.fillRect(0, 0, W, H);

    const bands = cfg.hist === 'rgb'
      ? [['r', 'rgba(255,80,80,.75)'], ['g', 'rgba(90,230,120,.75)'], ['b', 'rgba(90,150,255,.75)']]
      : [['y', 'rgba(235,240,250,.8)']];

    // Puncak dipakai bersama semua kanal supaya tinggi antar kanal sebanding.
    let peak = 1;
    for (const [k] of bands) for (const v of hist[k]) if (v > peak) peak = v;

    const bw = W / 64;
    g.globalCompositeOperation = cfg.hist === 'rgb' ? 'lighter' : 'source-over';
    for (const [k, color] of bands) {
      g.fillStyle = color;
      for (let i = 0; i < 64; i++) {
        const bh = (hist[k][i] / peak) * (H - 2);
        g.fillRect(i * bw, H - bh, Math.max(1, bw - 0.5), bh);
      }
    }
    g.globalCompositeOperation = 'source-over';

    // Penanda 0 dan 100 IRE: batas hitam pekat dan clipping.
    g.fillStyle = 'rgba(255,255,255,.22)';
    g.fillRect(0, 0, 1, H);
    g.fillRect(W - 1, 0, 1, H);
  }

  function tick() {
    const cfg = getConfig();
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);

    const rect = contentRect(video, canvas.width, canvas.height, cfg.fit);
    const anyScope = cfg.hist !== 'off' || cfg.zebra !== 'off' || cfg.peak !== 'off' || cfg.falseColor;

    if (anyScope && video.videoWidth) {
      const maskData = analyse(cfg);
      if (maskData) {
        mctx.putImageData(maskData, 0, 0);
        // Tanpa smoothing: zebra harus tetap berupa garis tegas, bukan kabut
        // abu-abu, setelah diperbesar dari 256px ke lebar layar.
        g.imageSmoothingEnabled = false;
        g.drawImage(mask, rect.x, rect.y, rect.w, rect.h);
        g.imageSmoothingEnabled = true;
      }
      drawHistogram(cfg);
    } else {
      drawHistogram({ hist: 'off' });
    }

    drawGuides(g, rect, cfg.guides);
  }

  return {
    resize() { resize(); tick(); },
    redraw: tick,
    start() {
      if (timer) return;
      resize();
      // ~6,7 Hz. Cukup cepat untuk terasa hidup, cukup lambat supaya tidak ikut
      // memanaskan HP yang sedang meng-encode 1080p60.
      timer = setInterval(tick, 150);
    },
    stop() {
      clearInterval(timer);
      timer = null;
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      scope.getContext('2d').clearRect(0, 0, scope.width, scope.height);
    },
  };
}

/**
 * Meter audio. Peak, bukan RMS: yang membuat rekaman rusak adalah puncak yang
 * clipping, dan RMS menyembunyikannya.
 */
export function createMeter({ bar, peakEl }) {
  let ctx = null;
  let analyser = null;
  let source = null;
  let raf = null;
  let peakHold = 0;
  let peakAt = 0;

  function stop() {
    cancelAnimationFrame(raf);
    raf = null;
    source?.disconnect();
    source = null;
    analyser = null;
    ctx?.close().catch(() => {});
    ctx = null;
    bar.style.width = '0%';
    bar.classList.remove('clip');
    if (peakEl) peakEl.textContent = '';
  }

  function attach(track) {
    stop();
    if (!track) return;
    ctx = new (window.AudioContext ?? window.webkitAudioContext)();
    source = ctx.createMediaStreamSource(new MediaStream([track]));
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; }

      // dBFS, dipetakan dari -60 dB. Skala linear membuat seluruh rentang
      // bicara yang berguna menumpuk di 10% pertama meter.
      const db = peak > 0 ? 20 * Math.log10(peak) : -100;
      const pct = Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
      bar.style.width = `${pct.toFixed(1)}%`;

      const now = performance.now();
      if (db > peakHold || now - peakAt > 1500) { peakHold = db; peakAt = now; }
      if (peakEl) peakEl.textContent = peakHold > -100 ? `${peakHold.toFixed(0)}dB` : '';
      bar.classList.toggle('clip', db > -1);

      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  return { attach, stop };
}
