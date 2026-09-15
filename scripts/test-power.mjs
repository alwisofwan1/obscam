// Beban CPU di HP.
//
// Tiga klaim yang tidak berguna kalau cuma diucapkan, jadi di sini diukur
// langsung dengan menghitung panggilan yang mahal:
//
//   getImageData            — readback GPU milik overlay
//   getFloatTimeDomainData  — pembacaan meter audio
//
// Plus: rem otomatis harus meringankan encoder TANPA me-restart kamera.
// Me-restart kamera di tengah take berarti framing bergeser dan semua setelan
// pro hilang — obat yang lebih buruk dari penyakitnya.
//
// Jalankan server dulu:  HTTP_PORT=8090 node server.js
import fs from 'node:fs';
import { loadChromium } from './chromium.mjs';

const chromium = await loadChromium();
if (!chromium) {
  console.log('SKIP  power — playwright tidak terpasang');
  process.exit(0);
}

const PORT = process.env.HTTP_PORT ?? 8090;
const BASE = `http://localhost:${PORT}`;
const TOKEN = process.env.OBSCAM_TOKEN
  ?? (() => { try { return fs.readFileSync('certs/token', 'utf8').trim(); } catch { return ''; } })();
const K = TOKEN ? `&k=${TOKEN}` : '';
const ROOM = 'power';
const log = [];
const check = (name, ok) => log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-capture',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const ctx = await browser.newContext();

  await ctx.addInitScript(() => {
    // --- penghitung kerja mahal ------------------------------------------
    window.__count = { img: 0, audio: 0 };

    const gid = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...a) {
      window.__count.img++;
      return gid.apply(this, a);
    };

    const gft = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData = function (...a) {
      window.__count.audio++;
      return gft.apply(this, a);
    };

    // --- paksa laporan CPU-limited, untuk menguji rem otomatis -----------
    window.__forceCpu = false;
    const getStats = RTCPeerConnection.prototype.getStats;
    RTCPeerConnection.prototype.getStats = async function (...a) {
      const report = await getStats.apply(this, a);
      if (!window.__forceCpu) return report;
      const out = new Map();
      report.forEach((v, k) => {
        out.set(k, v.type === 'outbound-rtp' && v.kind === 'video'
          ? { ...v, qualityLimitationReason: 'cpu' }
          : v);
      });
      return out;
    };

    // --- kamera & mic tiruan ---------------------------------------------
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const cx = canvas.getContext('2d');
    let t = 0;
    setInterval(() => { t += 7; cx.fillStyle = `hsl(${t % 360} 60% 50%)`; cx.fillRect(0, 0, 640, 480); }, 40);
    const base = canvas.captureStream(30);

    navigator.mediaDevices.getUserMedia = async (c = {}) => {
      if (c.audio && !c.video) {
        const ac = new AudioContext();
        const osc = ac.createOscillator();
        const dest = ac.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        return dest.stream;
      }
      return base.clone();
    };
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'fake-cam', label: 'Fake Cam', groupId: '' },
      { kind: 'audioinput', deviceId: 'fake-mic', label: 'Fake Mic', groupId: '' },
    ];
  });

  const sender = await ctx.newPage();
  sender.on('pageerror', (e) => check(`tanpa error halaman (${e.message})`, false));
  await sender.goto(`${BASE}/?room=${ROOM}${K}`);
  await sender.click('#btnGo');
  await sender.waitForFunction(() => document.getElementById('btnGo').dataset.live === '1');

  const obs = await ctx.newPage();
  await obs.goto(`${BASE}/obs?room=${ROOM}${K}`);
  await obs.waitForFunction(() => document.getElementById('v').videoWidth > 0, null, { timeout: 20000 });

  const frames = () => obs.evaluate(
    () => document.getElementById('v').getVideoPlaybackQuality().totalVideoFrames,
  );

  // Berapa kali kerja mahal terjadi dalam jendela waktu tertentu.
  const rate = async (key, ms = 1500) => {
    const a = await sender.evaluate((k) => window.__count[k], key);
    await wait(ms);
    const b = await sender.evaluate((k) => window.__count[k], key);
    return b - a;
  };

  // Nyalakan histogram + mic supaya kedua loop benar-benar bekerja.
  await sender.click('#stage', { position: { x: 8, y: 8 } });
  await sender.click('#btnPanel');
  await sender.click('#tabMon');
  await sender.selectOption('#histMode', 'luma');
  await sender.click('#tabStream');
  await sender.click('#btnPanel');
  await sender.click('#stage', { position: { x: 8, y: 8 } });
  await sender.click('#btnMic');
  await wait(800);

  check('overlay bekerja saat terlihat', (await rate('img')) > 3);
  check('meter audio bekerja saat terlihat', (await rate('audio')) > 3);

  // --- blackout ------------------------------------------------------------
  await sender.click('#stage', { position: { x: 8, y: 8 } });
  await sender.click('#btnBlackout');
  await wait(600);

  check('blackout: overlay berhenti total', (await rate('img')) === 0);
  check('blackout: meter audio berhenti total', (await rate('audio')) === 0);
  check('blackout: preview dilepas',
    await sender.evaluate(() => document.getElementById('preview').srcObject === null));

  // Yang berhenti hanya pekerjaan menggambar; siaran tidak boleh terganggu.
  const f1 = await frames();
  await wait(1500);
  check('blackout: OBS tetap menerima video', (await frames()) > f1);

  await sender.evaluate(() => {
    const el = document.getElementById('blackout');
    el.dispatchEvent(new Event('dblclick', { bubbles: true }));
  });
  await wait(600);
  check('keluar blackout: preview tersambung lagi',
    await sender.evaluate(() => !!document.getElementById('preview').srcObject));
  check('keluar blackout: overlay jalan lagi', (await rate('img')) > 3);

  // --- chrome auto-hide ----------------------------------------------------
  // Scope ikut disembunyikan CSS saat chrome menghilang, jadi loop-nya tidak
  // boleh terus menganalisis untuk sesuatu yang tidak terlihat.
  await sender.waitForFunction(() => document.body.classList.contains('idle'), null, { timeout: 12000 });
  check('chrome tersembunyi: overlay berhenti', (await rate('img')) === 0);
  check('chrome tersembunyi: meter berhenti', (await rate('audio')) === 0);

  await sender.click('#stage', { position: { x: 8, y: 8 } });
  await wait(500);
  check('chrome muncul lagi: overlay jalan lagi', (await rate('img')) > 3);

  // --- rem otomatis --------------------------------------------------------
  const trackBefore = await sender.evaluate(
    () => document.getElementById('preview').srcObject.getVideoTracks()[0].id,
  );

  await sender.evaluate(() => { window.__forceCpu = true; });
  const braked = await sender.waitForFunction(
    () => !document.getElementById('chipBrake').hidden,
    null, { timeout: 20000 },
  ).then(() => true).catch(() => false);
  check('rem otomatis aktif saat CPU mentok', braked);

  check('rem otomatis: langkah pertama membatasi fps',
    await sender.evaluate(() => document.getElementById('chipBrake').textContent.includes('fps dibatasi 30')));

  check('rem otomatis: kamera TIDAK di-restart',
    await sender.evaluate((id) => document.getElementById('preview').srcObject
      .getVideoTracks()[0].id === id, trackBefore));

  check('rem otomatis: video tetap mengalir ke OBS', (await frames()) > 0);

  // Dimatikan lewat panel harus melepas rem.
  await sender.click('#stage', { position: { x: 8, y: 8 } });
  await sender.click('#btnPanel');
  await sender.click('#btnAutoBrake');
  await wait(1500);
  check('rem otomatis bisa dimatikan',
    await sender.evaluate(() => document.getElementById('chipBrake').hidden));
} finally {
  await browser.close();
}

console.log(log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
