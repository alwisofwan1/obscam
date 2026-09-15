// Regresi panel kontrol pro.
//
// Bug yang ditemukan di HP asli: setelah Eksposur diubah ke `manual`, slider
// Shutter dan ISO tetap mati. Penyebabnya bukan kameranya — sebagian HP tidak
// pernah meng-echo exposureMode/focusMode/whiteBalanceMode di getSettings(),
// walau modenya ada di getCapabilities() dan benar-benar berpindah. Gerbang
// slider menunggu konfirmasi yang tidak akan datang.
//
// Test ini memakai dua HP tiruan:
//   "silent"  — kapabilitas lengkap, getSettings() TIDAK PERNAH menyebut mode.
//   "vokal"   — melapor normal, tapi dengan jeda 250 ms (HP asli tidak instan).
// Keduanya harus membuka slider manual.
//
// Jalankan server dulu:  HTTP_PORT=8090 node server.js
import fs from 'node:fs';
import { loadChromium } from './chromium.mjs';

const chromium = await loadChromium();
if (!chromium) {
  console.log('SKIP  procontrol — playwright tidak terpasang');
  process.exit(0);
}

const PORT = process.env.HTTP_PORT ?? 8090;
const BASE = `http://localhost:${PORT}`;
const TOKEN = process.env.OBSCAM_TOKEN
  ?? (() => { try { return fs.readFileSync('certs/token', 'utf8').trim(); } catch { return ''; } })();
const K = TOKEN ? `&k=${TOKEN}` : '';
const log = [];
const check = (name, ok) => log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-capture',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

// `mode` dibaca di dalam browser lewat argumen addInitScript.
function stub(mode) {
  return (kind) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const cx = canvas.getContext('2d');
    setInterval(() => { cx.fillStyle = '#345'; cx.fillRect(0, 0, 640, 480); }, 40);
    const base = canvas.captureStream(30);

    const CAPS = {
      exposureMode: ['continuous', 'manual'],
      exposureTime: { min: 10, max: 5000, step: 10 },
      iso: { min: 50, max: 3200, step: 50 },
      focusMode: ['continuous', 'manual'],
      focusDistance: { min: 0, max: 10, step: 0.1 },
      whiteBalanceMode: ['continuous', 'manual'],
      colorTemperature: { min: 2500, max: 7500, step: 50 },
    };
    const MODES = ['exposureMode', 'focusMode', 'whiteBalanceMode'];

    navigator.mediaDevices.getUserMedia = async (c = {}) => {
      if (c.audio && !c.video) return new AudioContext().createMediaStreamDestination().stream;
      const clone = base.clone();
      const vt = clone.getVideoTracks()[0];

      // Nilai yang "berlaku" di kamera tiruan.
      const state = {
        exposureMode: 'continuous', focusMode: 'continuous', whiteBalanceMode: 'continuous',
        exposureTime: 200, iso: 400, focusDistance: 1, colorTemperature: 5600,
      };

      vt.getCapabilities = () => ({ ...CAPS, deviceId: 'fake-cam' });

      const real = vt.getSettings.bind(vt);
      vt.getSettings = () => {
        const out = { ...real(), deviceId: 'fake-cam' };
        for (const [k, v] of Object.entries(state)) {
          // HP "silent": kapabilitasnya ada, tapi modenya tidak pernah dilapor.
          if (kind === 'silent' && MODES.includes(k)) continue;
          out[k] = v;
        }
        return out;
      };

      vt.applyConstraints = async (c2 = {}) => {
        const sets = c2.advanced ?? [c2];
        for (const set of sets) {
          for (const [k, v] of Object.entries(set)) {
            if (!(k in state)) continue;
            if (Array.isArray(CAPS[k]) && !CAPS[k].includes(v)) throw new DOMException(k, "OverconstrainedError");
            // HP asli tidak berpindah mode seketika.
            const delay = MODES.includes(k) ? 250 : 0;
            setTimeout(() => { state[k] = v; }, delay);
          }
        }
      };
      return clone;
    };

    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'fake-cam', label: 'Fake Cam', groupId: '' },
    ];
    navigator.mediaDevices.getSupportedConstraints = () => ({ pointsOfInterest: true });
  };
}

// Baris di panel pro dikenali lewat label-nya; tidak ada id per-kontrol.
const rowState = (label) => (l) => {
  const row = [...document.querySelectorAll('#pro .row')]
    .find((r) => r.querySelector('label')?.textContent.startsWith(l));
  if (!row) return null;
  const el = row.querySelector('input, select');
  return { disabled: !!el?.disabled, gated: row.classList.contains('gated') };
};

try {
  for (const kind of ['silent', 'vokal']) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(stub(kind), kind);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => check(`${kind}: tanpa error halaman (${e.message})`, false));
    await p.goto(`${BASE}/?room=pro-${kind}${K}`);

    await p.click('#btnGo');
    await p.waitForFunction(() => document.getElementById('btnGo').dataset.live === '1');
    await p.click('#btnPanel');
    await p.click('#tabPro');

    check(`${kind}: slider ISO ada`, (await p.evaluate(rowState('ISO'), 'ISO')) !== null);
    check(`${kind}: ISO terkunci selagi eksposur auto`,
      (await p.evaluate(rowState('ISO'), 'ISO'))?.disabled === true);

    // Inilah bug-nya: ubah mode ke manual, slider harus terbuka.
    await p.selectOption('#pro .row:has(label:text-is("Eksposur")) select', 'manual');
    const opened = await p.waitForFunction(() => {
      const row = [...document.querySelectorAll('#pro .row')]
        .find((r) => r.querySelector('label')?.textContent.startsWith('ISO'));
      return row && !row.querySelector('input').disabled;
    }, null, { timeout: 5000 }).then(() => true).catch(() => false);
    check(`${kind}: ISO terbuka setelah Eksposur = manual`, opened);

    check(`${kind}: Shutter ikut terbuka`,
      (await p.evaluate(rowState('Shutter'), 'Shutter'))?.disabled === false);
    check(`${kind}: tidak ada pesan penolakan`,
      await p.evaluate(() => document.querySelector('#pro .hint.warn')?.hidden !== false));

    // Nilai yang digeser harus benar-benar terkirim, bukan ditelan gerbang.
    await p.evaluate(() => {
      const row = [...document.querySelectorAll('#pro .row')]
        .find((r) => r.querySelector('label')?.textContent.startsWith('ISO'));
      const el = row.querySelector('input');
      el.value = 1600;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await p.waitForTimeout(700);
    check(`${kind}: nilai ISO benar-benar diterapkan ke track`,
      await p.evaluate(() => document.querySelector('#preview').srcObject
        .getVideoTracks()[0].getSettings().iso === 1600));

    // Kembali ke auto harus mengunci ulang.
    await p.selectOption('#pro .row:has(label:text-is("Eksposur")) select', 'continuous');
    await p.waitForTimeout(700);
    check(`${kind}: ISO terkunci lagi saat kembali ke auto`,
      (await p.evaluate(rowState('ISO'), 'ISO'))?.disabled === true);

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
