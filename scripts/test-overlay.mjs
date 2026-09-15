// Unit test pemetaan overlay.
//
// contentRect() menentukan di mana gambar BENAR-BENAR tergambar di dalam
// elemen <video>. Kalau salah, zebra menandai pilar hitam dan rule of thirds
// meleset dari framing sebenarnya — dan itu tidak kelihatan seperti bug,
// cuma seperti alatnya tidak akurat.
import { contentRect } from '../public/overlay.js';

const log = [];
const check = (name, ok) => log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const near = (a, b) => Math.abs(a - b) < 0.01;
const vid = (w, h) => ({ videoWidth: w, videoHeight: h });

// Sumber 16:9 di kanvas 16:9 — pas, tanpa sisa.
let r = contentRect(vid(1920, 1080), 800, 450, 'contain');
check('16:9 di 16:9 mengisi penuh', near(r.x, 0) && near(r.y, 0) && near(r.w, 800) && near(r.h, 450));

// Sumber 16:9 di kanvas landscape yang lebih lebar -> pilar kiri/kanan.
r = contentRect(vid(1920, 1080), 1000, 450, 'contain');
check('contain: pilar kiri-kanan simetris', near(r.w, 800) && near(r.h, 450) && near(r.x, 100) && near(r.y, 0));

// Sumber 16:9 di kanvas portrait -> letterbox atas/bawah.
r = contentRect(vid(1920, 1080), 390, 844, 'contain');
check('contain: letterbox atas-bawah', near(r.w, 390) && near(r.h, 219.375) && near(r.y, (844 - 219.375) / 2));

// cover memotong, jadi kotaknya melebihi kanvas dan offsetnya negatif.
r = contentRect(vid(1920, 1080), 390, 844, 'cover');
check('cover: mengisi tinggi penuh', near(r.h, 844));
check('cover: melebar keluar kanvas', r.w > 390 && r.x < 0);
check('cover: tidak menyisakan celah', r.x <= 0 && r.y <= 0);

// Sumber portrait (HP dipegang tegak) di kanvas landscape.
r = contentRect(vid(1080, 1920), 800, 450, 'contain');
check('sumber portrait: tinggi yang membatasi', near(r.h, 450) && near(r.w, 253.125));

// Belum ada frame: jangan memetakan ke kotak berukuran nol, garis bantu harus
// tetap tergambar penuh.
r = contentRect(vid(0, 0), 800, 450, 'contain');
check('tanpa dimensi video: pakai seluruh kanvas', near(r.w, 800) && near(r.h, 450));

// Pusat gambar harus selalu jatuh di pusat kanvas untuk contain.
for (const [vw, vh, cw, ch] of [[1920, 1080, 1000, 450], [1080, 1920, 800, 450], [640, 480, 390, 844]]) {
  const c = contentRect(vid(vw, vh), cw, ch, 'contain');
  if (!near(c.x + c.w / 2, cw / 2) || !near(c.y + c.h / 2, ch / 2)) {
    check(`pusat gambar = pusat kanvas (${vw}x${vh} di ${cw}x${ch})`, false);
  }
}
check('pusat gambar selalu di pusat kanvas', !log.some((l) => l.includes('pusat gambar =')));

// Aspek gambar tidak boleh berubah, apa pun kanvasnya.
for (const fit of ['contain', 'cover']) {
  const c = contentRect(vid(1920, 1080), 390, 844, fit);
  if (!near(c.w / c.h, 1920 / 1080)) check(`aspek terjaga (${fit})`, false);
}
check('aspek rasio terjaga di contain & cover', !log.some((l) => l.includes('aspek terjaga')));

console.log(log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
