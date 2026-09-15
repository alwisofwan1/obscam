// Panel kontrol kamera pro, dipakai DUA halaman:
//
//   sender (HP)  — adapter memanggil camera.js langsung.
//   control (PC) — adapter mengirim perintah lewat DataChannel dan membaca
//                  state yang dipancarkan HP.
//
// Karena itu modul ini tidak tahu apa-apa soal MediaStreamTrack. Semua akses
// kamera lewat `adapter`, dan seluruh perilaku gerbang mode — bagian yang dulu
// paling sering salah — hidup di satu tempat saja.

import { PRO_SPEC, KELVIN_PRESETS } from './camera.js';

// Nilai manual -> (mode yang mengendalikannya, nilai mode yang dibutuhkan).
const GATED = {
  exposureTime: ['exposureMode', 'manual'],
  iso: ['exposureMode', 'manual'],
  focusDistance: ['focusMode', 'manual'],
  colorTemperature: ['whiteBalanceMode', 'manual'],
};

export const hint = (text) =>
  Object.assign(document.createElement('div'), { className: 'hint', textContent: text });

/**
 * @param {object} o
 * @param {HTMLElement} o.box        wadah panel
 * @param {object} o.adapter         { ready, caps, settings, modeOf, apply, setMode,
 *                                     silentModes, supportsPoi, footer }
 */
export function buildProPanel({ box, adapter }) {
  const caps = adapter.caps() ?? {};
  const settings = adapter.settings() ?? {};
  box.replaceChildren();

  if (!adapter.ready()) {
    box.append(hint(adapter.idleText ?? 'Nyalakan kamera dulu — kontrol yang muncul mengikuti apa yang benar-benar didukung HP ini.'));
    return;
  }

  box.append(hint('Kontrol yang redup sedang dipegang mode otomatis — ubah Eksposur / Fokus / White bal. ke manual untuk membukanya.'));
  const note = Object.assign(document.createElement('div'), { className: 'hint warn', hidden: true });
  box.append(note);

  const rows = new Map();
  let count = 0;

  for (const [key, label, fmt, kind] of PRO_SPEC) {
    const cap = caps[key];
    if (!cap) continue;

    const row = document.createElement('div');
    row.className = 'row';
    row.append(Object.assign(document.createElement('label'), { textContent: label }));

    if (kind === 'mode' || Array.isArray(cap)) {
      if (!Array.isArray(cap) || cap.length < 2) continue;
      const sel = document.createElement('select');
      sel.append(...cap.map((m) => Object.assign(document.createElement('option'), { value: m, textContent: m })));
      const eff = adapter.modeOf(key) ?? settings[key];
      if (eff != null && cap.includes(eff)) sel.value = eff;
      sel.onchange = async () => {
        const want = sel.value;
        sel.disabled = true;
        const ok = await adapter.setMode(key, want);
        sel.disabled = false;
        // Mode berubah -> kontrol manual yang digerbanginya ikut hidup/mati.
        sel.value = adapter.modeOf(key) ?? want;
        syncGates();
        // Kalau HP menolak, katakan. Membiarkan slider mati tanpa alasan
        // persis yang membuat panel ini terasa rusak.
        note.textContent = ok ? '' : `HP menolak ${label} = ${want}.`;
        note.hidden = ok;
      };
      row.append(sel);
    } else if (typeof cap === 'object' && cap.max > cap.min) {
      const r = document.createElement('input');
      r.type = 'range';
      r.min = cap.min;
      r.max = cap.max;
      r.step = cap.step || (cap.max - cap.min) / 100;
      r.value = settings[key] ?? cap.min;
      const out = Object.assign(document.createElement('span'), { className: 'val' });
      const show = (v) => { out.textContent = (fmt ?? ((x) => `${Math.round(x * 100) / 100}`))(Number(v)); };
      show(r.value);
      r.oninput = () => show(r.value);
      // 'change' bukan 'input': applyConstraints tiap pixel geser bikin kamera
      // tersendat, dan lewat DataChannel jadi banjir pesan.
      r.onchange = async () => {
        const actual = await adapter.apply(key, Number(r.value));
        if (actual != null) { r.value = actual; show(actual); }
      };
      row.append(r, out);
    } else {
      continue;
    }

    box.append(row);
    rows.set(key, row);
    count++;

    // Preset Kelvin langsung di bawah slider suhu warna — jauh lebih cepat
    // dipakai daripada menggeser slider mencari 5600K.
    if (key === 'colorTemperature') {
      const bar = document.createElement('div');
      bar.className = 'btnrow';
      for (const [k, name] of KELVIN_PRESETS) {
        if (k < cap.min || k > cap.max) continue;
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: `${k / 1000}K`, title: name });
        b.onclick = async () => {
          const actual = await adapter.apply('colorTemperature', k);
          const slider = rows.get('colorTemperature')?.querySelector('input');
          if (slider && actual != null) slider.value = actual;
          syncGates();
        };
        bar.append(b);
      }
      if (bar.children.length) box.append(bar);
    }
  }

  function syncGates() {
    for (const [key, [modeKey, needed]] of Object.entries(GATED)) {
      const row = rows.get(key);
      if (!row) continue;
      // modeOf(), bukan getSettings(): sebagian HP tidak pernah meng-echo
      // exposureMode/focusMode/whiteBalanceMode walau modenya benar berpindah.
      // Menggerbangi slider pada echo yang tidak datang = slider mati selamanya.
      const active = adapter.modeOf(modeKey) === needed;
      row.querySelectorAll('input, select').forEach((el) => { el.disabled = !active; });
      row.classList.toggle('gated', !active);
      const val = row.querySelector('.val');
      if (val) {
        if (!active) { val.dataset.keep = val.dataset.keep ?? val.textContent; val.textContent = 'auto'; }
        else if (val.dataset.keep != null) { val.textContent = val.dataset.keep; delete val.dataset.keep; }
      }
    }
  }
  syncGates();

  if (!count) {
    box.append(hint('Kamera ini tidak mengekspos kontrol manual apa pun ke browser. Chrome Android paling lengkap; Safari iOS hampir tidak ada.'));
  }
  const silent = adapter.silentModes?.() ?? [];
  if (silent.length) {
    box.append(hint(`Catatan: HP ini tidak melaporkan ${silent.join(', ')} kembali ke browser. ` +
      'Perpindahan mode tetap diterapkan, tapi tidak bisa diverifikasi — kalau gambar tidak berubah, ' +
      'berarti lensa itu memang tidak mendukungnya.'));
  }
  for (const line of adapter.footer?.() ?? []) box.append(hint(line));
}
