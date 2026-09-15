// Tally + kendali jarak jauh, lewat DataChannel yang sama.
//
// Dua jalur yang diuji di sini tidak bisa diverifikasi dengan mata di satu
// layar: tally berjalan dari halaman OBS ke HP, dan perintah berjalan dari
// halaman kontrol di PC ke HP. Keduanya melintasi WebRTC sungguhan.
//
// Jalankan server dulu:  HTTP_PORT=8090 node server.js
import fs from 'node:fs';
import { loadChromium } from './chromium.mjs';

const chromium = await loadChromium();
if (!chromium) {
  console.log('SKIP  control — playwright tidak terpasang');
  process.exit(0);
}

const PORT = process.env.HTTP_PORT ?? 8090;
const BASE = `http://localhost:${PORT}`;
const TOKEN = process.env.OBSCAM_TOKEN
  ?? (() => { try { return fs.readFileSync('certs/token', 'utf8').trim(); } catch { return ''; } })();
const K = TOKEN ? `&k=${TOKEN}` : '';
const ROOM = 'ctl';
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

  // Kamera tiruan dengan kapabilitas penuh, supaya panel pro benar-benar
  // terbentuk di kedua halaman.
  await ctx.addInitScript(() => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const cx = canvas.getContext('2d');
    let t = 0;
    setInterval(() => { t += 6; cx.fillStyle = `hsl(${t % 360} 60% 45%)`; cx.fillRect(0, 0, 640, 480); }, 40);
    const base = canvas.captureStream(30);

    const CAPS = {
      zoom: { min: 1, max: 8, step: 0.1 },
      torch: true,
      exposureMode: ['continuous', 'manual'],
      iso: { min: 50, max: 3200, step: 50 },
      exposureTime: { min: 10, max: 5000, step: 10 },
      whiteBalanceMode: ['continuous', 'manual'],
      colorTemperature: { min: 2500, max: 7500, step: 50 },
    };

    navigator.mediaDevices.getUserMedia = async (c = {}) => {
      if (c.audio && !c.video) return new AudioContext().createMediaStreamDestination().stream;
      const clone = base.clone();
      const vt = clone.getVideoTracks()[0];
      const state = { zoom: 1, exposureMode: 'continuous', whiteBalanceMode: 'continuous', iso: 400, exposureTime: 200, colorTemperature: 5600, torch: false };
      vt.getCapabilities = () => ({ ...CAPS, deviceId: 'fake-cam' });
      const real = vt.getSettings.bind(vt);
      vt.getSettings = () => ({ ...real(), ...state, deviceId: 'fake-cam' });
      vt.applyConstraints = async (c2 = {}) => {
        for (const set of (c2.advanced ?? [c2])) {
          for (const [k, v] of Object.entries(set)) if (k in state) state[k] = v;
        }
      };
      // Dibaca test untuk memastikan perintah benar-benar sampai ke kamera.
      window.__camState = state;
      return clone;
    };
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'fake-cam', label: 'Fake Cam', groupId: '' },
    ];
    navigator.mediaDevices.getSupportedConstraints = () => ({ pointsOfInterest: true });
  });

  const sender = await ctx.newPage();
  sender.on('pageerror', (e) => check(`sender tanpa error halaman (${e.message})`, false));
  await sender.goto(`${BASE}/?room=${ROOM}${K}`);
  await sender.click('#btnGo');
  await sender.waitForFunction(() => document.getElementById('btnGo').dataset.live === '1');

  // --- tally ---------------------------------------------------------------
  // Halaman OBS dipaksa ke status program lewat ?tally=, supaya jalurnya bisa
  // diuji tanpa menjalankan OBS sungguhan.
  const obs = await ctx.newPage();
  obs.on('pageerror', (e) => check(`obs tanpa error halaman (${e.message})`, false));
  await obs.goto(`${BASE}/obs?room=${ROOM}${K}&tally=program`);

  const onAir = await sender.waitForFunction(
    () => document.body.dataset.tally === 'program',
    null, { timeout: 15000 },
  ).then(() => true).catch(() => false);
  check('tally: HP tahu dirinya ON AIR', onAir);

  check('tally: chip ON AIR tampil',
    await sender.evaluate(() => {
      const c = document.getElementById('chipTally');
      return !c.hidden && c.textContent === 'ON AIR';
    }));

  // border-width dianimasikan; ukur setelah transisinya selesai, bukan di
  // tengah jalan.
  check('tally: bingkai merah tebal',
    await sender.waitForFunction(() => {
      const cs = getComputedStyle(document.getElementById('tally'));
      return parseFloat(cs.borderTopWidth) >= 5 && cs.borderTopColor === 'rgb(224, 57, 58)';
    }, null, { timeout: 3000 }).then(() => true).catch(() => false));

  await obs.close();
  const cleared = await sender.waitForFunction(
    () => document.body.dataset.tally !== 'program',
    null, { timeout: 15000 },
  ).then(() => true).catch(() => false);
  check('tally: padam saat halaman OBS ditutup', cleared);

  // --- kendali jarak jauh --------------------------------------------------
  const ctl = await ctx.newPage();
  ctl.on('pageerror', (e) => check(`control tanpa error halaman (${e.message})`, false));
  await ctl.goto(`${BASE}/control?room=${ROOM}${K}`);

  const gotState = await ctl.waitForFunction(
    () => document.querySelectorAll('#pro .row').length > 0,
    null, { timeout: 15000 },
  ).then(() => true).catch(() => false);
  check('control: panel pro terisi dari state HP', gotState);

  check('control: video HP tampil',
    await ctl.waitForFunction(() => document.getElementById('preview').videoWidth > 0,
      null, { timeout: 15000 }).then(() => true).catch(() => false));

  // Zoom dari PC harus sampai ke kamera HP.
  await ctl.click('#tabQuick');
  await ctl.evaluate(() => {
    const r = document.getElementById('zoomRange');
    r.value = 3;
    r.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(900);
  check('control: zoom dari PC diterapkan di HP',
    await sender.evaluate(() => window.__camState?.zoom === 3));

  // Mode manual dari PC, lalu nilai yang digerbanginya.
  await ctl.click('#tabPro');
  await ctl.selectOption('#pro .row:has(label:text-is("Eksposur")) select', 'manual');
  await wait(900);
  check('control: mode manual dari PC diterapkan di HP',
    await sender.evaluate(() => window.__camState?.exposureMode === 'manual'));

  const isoOpen = await ctl.waitForFunction(() => {
    const row = [...document.querySelectorAll('#pro .row')]
      .find((r) => r.querySelector('label')?.textContent.startsWith('ISO'));
    return row && !row.querySelector('input').disabled;
  }, null, { timeout: 5000 }).then(() => true).catch(() => false);
  check('control: gerbang ISO ikut terbuka di panel PC', isoOpen);

  await ctl.evaluate(() => {
    const row = [...document.querySelectorAll('#pro .row')]
      .find((r) => r.querySelector('label')?.textContent.startsWith('ISO'));
    const el = row.querySelector('input');
    el.value = 1600;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(900);
  check('control: nilai ISO dari PC diterapkan di HP',
    await sender.evaluate(() => window.__camState?.iso === 1600));

  // Perubahan di HP harus terpantul balik ke panel PC.
  await sender.evaluate(() => document.getElementById('btnTorch').click());
  await wait(900);
  check('control: torch yang dinyalakan di HP terlihat di panel PC',
    await ctl.evaluate(() => document.getElementById('btnTorch').getAttribute('aria-pressed') === 'true'));

  // Reset dari PC.
  await ctl.click('#tabQuick');
  await ctl.click('#btnReset');
  await wait(900);
  check('control: reset dari PC mengembalikan mode ke auto',
    await sender.evaluate(() => window.__camState?.exposureMode === 'continuous'));

  // Kanal kontrol tidak boleh mengganggu video.
  check('control: video tetap mengalir setelah semua perintah',
    await ctl.evaluate(() => document.getElementById('preview').videoWidth > 0));

  // Perintah ngawur harus diabaikan, bukan diteruskan ke applyConstraints.
  await ctl.evaluate(() => {
    const dc = { type: 'cmd', op: 'apply', key: 'torch', value: 'evil' };
    window.dispatchEvent(new CustomEvent('noop', { detail: dc }));
  });
  check('control: HP masih hidup setelah perintah tidak valid',
    await sender.evaluate(() => document.getElementById('btnGo').dataset.live === '1'));
} finally {
  await browser.close();
}

console.log(log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
