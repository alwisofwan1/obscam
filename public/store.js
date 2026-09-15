// Persistensi setelan di localStorage.
//
// Dua lapis:
//   prefs  — setelan transport (resolusi, fps, bitrate, codec) yang berlaku
//            global untuk HP ini.
//   looks  — snapshot kontrol kamera pro, disimpan PER deviceId. Kapabilitas
//            tiap lensa beda-beda, jadi "Whiteboard" di lensa utama tidak
//            boleh bocor ke ultrawide.
//
// Semua akses dibungkus try/catch: mode privat / storage penuh tidak boleh
// membuat halaman kamera gagal jalan.

const KEY = 'obscam.v1';

const DEFAULTS = {
  res: '1920x1080',
  fps: '30',
  bitrate: '8000000',
  codec: 'auto',
  degradation: 'maintain-resolution',
  mic: false,
  mirror: false,
  fit: 'contain',
  guides: 'off',
  hist: 'off',
  zebra: 'off',
  peak: 'off',
  falseColor: false,
  autoBrake: true,
  camId: '',
};

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function write(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj));
  } catch {}
}

let db = read();
if (!db.prefs) db.prefs = {};
if (!db.looks) db.looks = {};

export const prefs = {
  get(key) {
    return db.prefs[key] ?? DEFAULTS[key];
  },
  set(key, value) {
    db.prefs[key] = value;
    write(db);
  },
  all() {
    return { ...DEFAULTS, ...db.prefs };
  },
};

// --- looks (profil kontrol pro per kamera) --------------------------------

// deviceId bisa sangat panjang; dipendekkan supaya storage tidak membengkak
// kalau HP punya banyak lensa.
const slot = (deviceId) => (deviceId || 'default').slice(0, 24);

export const looks = {
  list(deviceId) {
    return Object.keys(db.looks[slot(deviceId)] ?? {}).sort();
  },
  get(deviceId, name) {
    return db.looks[slot(deviceId)]?.[name] ?? null;
  },
  save(deviceId, name, settings) {
    const s = slot(deviceId);
    db.looks[s] = db.looks[s] ?? {};
    db.looks[s][name] = settings;
    write(db);
  },
  remove(deviceId, name) {
    delete db.looks[slot(deviceId)]?.[name];
    write(db);
  },
};

export function resetAll() {
  db = { prefs: {}, looks: {} };
  write(db);
}
