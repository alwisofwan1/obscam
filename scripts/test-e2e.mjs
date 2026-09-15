// E2E: buka halaman sender + halaman OBS di browser asli, lalu pastikan
// video benar-benar sampai lewat WebRTC & frame terus bertambah.
//
// Kamera fisik/fake-device Chrome tidak tersedia di headless box ini, jadi
// getUserMedia di-stub dengan canvas.captureStream(). Yang diuji tetap
// seluruh jalur nyata: signaling, offer/answer, ICE, encode/decode video.
//
// Jalankan server dulu:  HTTP_PORT=8090 node server.js
// Lalu:                  node scripts/test-e2e.mjs
import fs from 'node:fs';
import { loadChromium } from './chromium.mjs';

const chromium = await loadChromium();
if (!chromium) {
  console.log('SKIP  e2e — playwright tidak terpasang (npm i -D playwright && npx playwright install chromium)');
  process.exit(0);
}

const PORT = process.env.HTTP_PORT ?? 8090;
const BASE = `http://localhost:${PORT}`;
const TOKEN = process.env.OBSCAM_TOKEN
  ?? (() => { try { return fs.readFileSync('certs/token', 'utf8').trim(); } catch { return ''; } })();
const K = TOKEN ? `&k=${TOKEN}` : '';
const ROOM = 'e2e';
const log = [];
const check = (name, ok) => log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  // Playwright pakai Chromium bundled kalau CHROME_PATH tidak diset.
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    '--use-fake-ui-for-media-stream',      // auto-allow permission kamera
    '--use-fake-device-for-media-capture', // kamera sintetis
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const ctx = await browser.newContext();

  // Stub kamera & mic. Video: canvas beranimasi. Audio: oscillator — perlu
  // sungguhan, karena test mic di bawah memverifikasi RTP audio benar-benar
  // mengalir setelah renegosiasi, bukan sekadar ada m-line.
  await ctx.addInitScript(() => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const cx = canvas.getContext('2d');
    let t = 0;
    setInterval(() => {
      t += 8;
      cx.fillStyle = `hsl(${t % 360} 70% 45%)`;
      cx.fillRect(0, 0, 640, 480);
      cx.fillStyle = '#fff';
      cx.font = '48px sans-serif';
      cx.fillText(String(t), 40, 240);
    }, 33);
    const video = canvas.captureStream(30);

    navigator.mediaDevices.getUserMedia = async (c = {}) => {
      if (c.audio && !c.video) {
        const ac = new AudioContext();
        const osc = ac.createOscillator();
        const dest = ac.createMediaStreamDestination();
        osc.frequency.value = 440;
        osc.connect(dest);
        osc.start();
        return dest.stream;
      }
      return video.clone();
    };
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'fake-cam', label: 'Fake Cam', groupId: '' },
      { kind: 'audioinput', deviceId: 'fake-mic', label: 'Fake Mic', groupId: '' },
    ];
  });

  const sender = await ctx.newPage();
  await sender.goto(`${BASE}/?room=${ROOM}${K}`);

  // Saat live, dock menyembunyikan diri setelah 4 detik diam. Operator
  // memunculkannya lagi dengan mengetuk preview — test melakukan hal yang sama
  // supaya jalur reveal-nya ikut teruji, bukan di-bypass.
  const tap = async (sel) => {
    await sender.click('#stage', { position: { x: 8, y: 8 } });
    await sender.click(sel);
  };
  await sender.click('#btnGo');
  await sender.waitForFunction(() => document.getElementById('btnGo').dataset.live === '1');
  check('sender: kamera terbuka & LIVE', true);

  const obs = await ctx.newPage();
  await obs.goto(`${BASE}/obs?room=${ROOM}${K}`);

  // video benar-benar punya dimensi = track sampai dan ter-decode
  await obs.waitForFunction(() => {
    const v = document.getElementById('v');
    return v.videoWidth > 0 && v.readyState >= 2;
  }, null, { timeout: 20000 });
  const dims = await obs.evaluate(() => {
    const v = document.getElementById('v');
    return { w: v.videoWidth, h: v.videoHeight };
  });
  check(`obs: video diterima (${dims.w}x${dims.h})`, dims.w > 0);

  check('obs: HUD tunggu tersembunyi',
    await obs.evaluate(() => document.getElementById('hud').classList.contains('hide')));

  check('sender: viewer tercatat 1',
    await sender.evaluate(() => document.getElementById('status').textContent.includes('tersambung: 1')));

  // frame benar-benar mengalir, bukan cuma frame pertama
  const frames = async () => obs.evaluate(
    () => document.getElementById('v').getVideoPlaybackQuality().totalVideoFrames,
  );
  const f1 = await frames();
  await wait(1500);
  const f2 = await frames();
  check(`obs: frame mengalir (${f1} -> ${f2})`, f2 > f1);

  // Menyalakan mic di tengah siaran dulu tidak pernah sampai ke OBS: track
  // audio ditambahkan tanpa ada yang menangani renegosiasi. Track receiver
  // tetap 'muted' sampai RTP benar-benar datang, jadi itu yang diperiksa.
  check('obs: audio belum mengalir sebelum mic on',
    await obs.evaluate(() => {
      const a = document.getElementById('v').srcObject?.getAudioTracks?.() ?? [];
      return a.length === 0 || a[0].muted;
    }));

  await tap('#btnMic');
  const micLive = await obs.waitForFunction(() => {
    const a = document.getElementById('v').srcObject?.getAudioTracks?.() ?? [];
    return a.length > 0 && !a[0].muted;
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('obs: audio mengalir setelah mic dinyalakan (renegosiasi)', micLive);

  // Video tidak boleh ikut terputus saat audio dinegosiasi ulang.
  const m1 = await frames();
  await wait(1200);
  check('obs: video tetap mengalir selama renegosiasi', (await frames()) > m1);

  // Ganti resolusi saat live memakai jalur replaceTrack — tidak boleh
  // menjatuhkan koneksi.
  await tap('#btnPanel');
  await sender.selectOption('#res', '1280x720');
  await wait(1800);
  const r1 = await frames();
  await wait(1200);
  check('obs: video tetap mengalir setelah ganti resolusi', (await frames()) > r1);

  // Alat monitor: harus benar-benar melukis, dan tidak boleh menyentuh stream
  // yang dikirim ke OBS (overlay murni lokal).
  await sender.click('#tabMon');
  await sender.selectOption('#histMode', 'luma');
  await sender.selectOption('#zebraMode', '70');
  await sender.selectOption('#peakMode', 'high');
  await sender.waitForTimeout(600);

  const painted = (id) => sender.evaluate((i) => {
    const c = document.getElementById(i);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let p = 3; p < d.length; p += 4) if (d[p] > 0) return true;
    return false;
  }, id);

  check('monitor: histogram tergambar', await painted('scope'));
  check('monitor: zebra/peaking tergambar di overlay', await painted('guides'));

  const o1 = await frames();
  await wait(1200);
  check('monitor: video ke OBS tidak terganggu overlay', (await frames()) > o1);

  await sender.selectOption('#histMode', 'off');
  await sender.selectOption('#zebraMode', 'off');
  await sender.selectOption('#peakMode', 'off');
  await sender.waitForTimeout(500);
  check('monitor: overlay bersih setelah dimatikan', !(await painted('guides')));

  await sender.click('#tabStream');

  check('drawer terbuka tidak menutupi preview',
    await sender.evaluate(() => {
      const st = document.getElementById('stage').getBoundingClientRect();
      return st.width === window.innerWidth && st.height === window.innerHeight;
    }));

  await sender.click('#btnPanel');
  await tap('#btnMic');

  // sender berhenti -> receiver kembali ke state tunggu
  await tap('#btnGo');
  await wait(1200);
  check('obs: reset saat sender stop',
    await obs.evaluate(() => !document.getElementById('hud').classList.contains('hide')));

  // urutan sebaliknya: OBS sudah jalan duluan, HP baru mulai kirim
  // (ini alur nyata paling umum)
  await sender.click('#btnGo');
  await obs.waitForFunction(() => document.getElementById('v').videoWidth > 0, null, { timeout: 20000 })
    .then(() => check('obs sudah terbuka duluan, sender menyusul', true))
    .catch(() => check('obs sudah terbuka duluan, sender menyusul', false));
} finally {
  await browser.close();
}

console.log(log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
