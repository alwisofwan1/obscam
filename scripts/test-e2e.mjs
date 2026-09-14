// E2E: buka halaman sender + halaman OBS di browser asli, lalu pastikan
// video benar-benar sampai lewat WebRTC & frame terus bertambah.
//
// Kamera fisik/fake-device Chrome tidak tersedia di headless box ini, jadi
// getUserMedia di-stub dengan canvas.captureStream(). Yang diuji tetap
// seluruh jalur nyata: signaling, offer/answer, ICE, encode/decode video.
//
// Jalankan server dulu:  HTTP_PORT=8090 node server.js
// Lalu:                  node scripts/test-e2e.mjs
import { execSync } from 'node:child_process';
import path from 'node:path';

const gRoot = execSync('npm root -g').toString().trim();
const { chromium } = await import(
  path.join(gRoot, '@playwright/cli/node_modules/playwright/index.mjs')
);

const PORT = process.env.HTTP_PORT ?? 8090;
const BASE = `http://localhost:${PORT}`;
const ROOM = 'e2e';
const log = [];
const check = (name, ok) => log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: [
    '--use-fake-ui-for-media-stream',      // auto-allow permission kamera
    '--use-fake-device-for-media-capture', // kamera sintetis
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const ctx = await browser.newContext();

  // Stub kamera: canvas beranimasi -> MediaStream 640x480@30
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
    const stream = canvas.captureStream(30);
    navigator.mediaDevices.getUserMedia = async () => stream.clone();
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'fake-cam', label: 'Fake Cam', groupId: '' },
    ];
  });

  const sender = await ctx.newPage();
  await sender.goto(`${BASE}/?room=${ROOM}`);
  await sender.click('#btnGo');
  await sender.waitForFunction(() => document.getElementById('btnGo').dataset.live === '1');
  check('sender: kamera terbuka & LIVE', true);

  const obs = await ctx.newPage();
  await obs.goto(`${BASE}/obs?room=${ROOM}`);

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

  // sender berhenti -> receiver kembali ke state tunggu
  await sender.click('#btnGo');
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
