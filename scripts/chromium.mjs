// Pencarian Playwright dipakai bersama oleh beberapa test, jadi ditaruh di
// satu tempat.
import { execSync } from 'node:child_process';
import path from 'node:path';

// Playwright dicari di beberapa tempat: dependency lokal, global npm root,
// atau @playwright/cli yang ikut terpasang bersama tooling lain. Kalau tidak
// ada sama sekali, test di-skip (bukan gagal) supaya `npm test` tetap berguna
// di mesin tanpa browser.
export async function loadChromium() {
  const gRoot = (() => {
    try { return execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { return null; }
  })();
  const candidates = [
    'playwright',
    gRoot && path.join(gRoot, 'playwright/index.mjs'),
    gRoot && path.join(gRoot, '@playwright/cli/node_modules/playwright/index.mjs'),
    gRoot && path.join(gRoot, '@playwright/test/node_modules/playwright/index.mjs'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return (await import(c)).chromium; } catch {}
  }
  return null;
}

