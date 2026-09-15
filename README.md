# obscam — kamera HP jadi sumber OBS

Kirim kamera bawaan HP (Android/iOS) ke OBS lewat WiFi pakai WebRTC.
Tanpa install app di HP, tanpa compile plugin OBS.

```
HP (browser, kamera)  ──WebRTC/LAN──►  PC  ──►  OBS Browser Source
        ▲                                │
        └────── signaling (WebSocket) ───┘
```

Latency di WiFi 5 GHz yang sehat: **±150–250 ms**. Video tidak melewati
internet — peer-to-peer di dalam LAN.

## Jalankan (di PC yang menjalankan OBS, bukan di VPS)

Syarat: Node.js 18+, HP dan PC di **WiFi yang sama**.

```bash
npm install
npm run cert     # sertifikat self-signed; sekali saja
npm start
```

Server mencetak **token room** dan dua URL lengkap — pakai URL apa adanya,
termasuk `?k=<token>`:

| Untuk | URL |
|---|---|
| HP (sender) | `https://<IP-PC>:8443/?room=default&k=<token>` |
| OBS (receiver) | `http://localhost:8080/obs?room=default&k=<token>&nohud=1` |
| Panel kontrol di PC | `http://localhost:8080/control?room=default&k=<token>` |

Token disimpan di `certs/token` supaya URL OBS tidak berubah tiap restart.
Ganti token: hapus file itu lalu restart, atau `OBSCAM_TOKEN=... npm start`.
Matikan auth di LAN tepercaya: `OBSCAM_NO_AUTH=1 npm start`.

## Setup OBS

1. **Sources → + → Browser**
2. URL: URL OBS dari terminal (yang ada `&nohud=1`)
3. Width/Height: `1920` × `1080`
4. Centang **Control audio via OBS** (kalau mic HP dipakai)
5. Jangan centang "Shutdown source when not visible" — bikin reconnect terus

Di HP: buka URL https, terima peringatan sertifikat (**Advanced → Proceed**),
izinkan akses kamera, tekan **Mulai kirim**.

### Parameter URL halaman OBS

| Param | Arti |
|---|---|
| `room=xxx` | Pisahkan beberapa HP/scene. Sender & receiver harus sama. Huruf/angka/`-`/`_`, maks 32. |
| `k=xxx` | Token. Wajib kecuali `OBSCAM_NO_AUTH=1`. |
| `nohud=1` | Sembunyikan teks "Menunggu kamera HP…" |
| `fit=cover` | Crop penuh layar (default `contain` = letterbox) |
| `rotate=90` | Putar gambar 90/180/270° di sisi OBS (gratis, tidak membebani HP) |
| `flip=h` | Cermin horizontal (`v`, `hv` juga bisa) |
| `buffer=60` | Target jitter buffer dalam ms. Default `0` = latency terendah; naikkan kalau WiFi berisik. |
| `tally=program` | Paksa status tally tanpa OBS — untuk menguji jalurnya di browser biasa. |

## UI sender

Halaman sender dirancang **landscape-first** — kamera selalu dipegang begitu.
Prinsipnya: *video adalah aplikasinya*. Semua kontrol mengambang di atas
preview dan tidak pernah mengubah ukurannya, jadi framing tidak bergeser saat
kamu menyetel eksposur.

```
┌──────────────────────────────────────────────────────────┐
│ ●LIVE  1080p60 · 8.2 Mbps · 18ms · 1 viewer      🔋87% ⚠ │  auto-hide 4 dtk
│ ┌──┐                                           ┌────────┐│
│ │Z │         PREVIEW FULL-BLEED                │ PANEL  ││  slide di ATAS
│ │O │         + garis bantu                     │ 340px  ││  video, tidak
│ │M │                                           │        ││  menggeser apa pun
│ └──┘                                           └────────┘│
│  [☰][🎙][🔦][🔒][⊞]                    [🌑][🔐]( ⏺ Stop )│  zona jempol
└──────────────────────────────────────────────────────────┘
```

| Gestur / tombol | Fungsi |
|---|---|
| Ketuk preview | Titik fokus & eksposur (`pointsOfInterest`). Saat chrome tersembunyi, ketukan pertama hanya memunculkannya kembali. |
| Cubit (pinch) | Zoom optik/sensor lewat constraint `zoom` — bukan CSS scale, jadi kualitasnya nyata. |
| Tekan-tahan preview / 🔒 | Kunci eksposur + fokus + white balance. Mencegah gambar "pumping" tiap ada orang lewat. |
| 🔐 | Kunci UI selama take. Buka dengan tekan-tahan. |
| 🌑 | Layar gelap, streaming tetap jalan — hemat baterai, tanpa cahaya layar bocor. Ketuk dua kali untuk kembali. |
| ⊞ | Garis bantu: rule of thirds + silang tengah, lalu + title-safe 90%. |
| 📊 | Matikan/nyalakan semua alat monitor sekaligus, susunan terakhir dipulihkan. |
| ☰ | Panel. Di landscape, dock dan rail zoom tetap bisa dipakai saat panel terbuka. |

Chrome (topbar + dock) menyembunyikan diri setelah 4 detik diam **hanya saat
live**; ketuk di mana saja untuk memunculkannya.

## Fitur sender

- Pilih kamera (depan/belakang/ultrawide/tele — semua yang diekspos HP)
- Resolusi 720p–4K, 24/25/30/50/60 fps, bitrate 2–40 Mbps
- Pemilih codec (H.264 / VP9 / AV1 / VP8) dan strategi saat bandwidth sesak
  (jaga resolusi / jaga framerate / seimbang)
- **Kontrol kamera (pro)** — panel yang digenerate dari `getCapabilities()`
  track: mode & kompensasi eksposur, shutter, ISO, mode fokus & jarak fokus,
  white balance + preset Kelvin (2800–6500K), brightness/kontras/saturasi/
  ketajaman. Isinya beda-beda per HP — yang tidak didukung tidak ditampilkan.
  Kontrol manual **digerbangi modenya**: slider ISO/shutter baru hidup setelah
  Eksposur = `manual`, dan nilai yang berlaku dibaca ulang dari `getSettings()`
  (HP sering meng-clamp ke nilai terdekat).
- **Look** — simpan seluruh setelan pro sebagai profil bernama, per lensa.
  "Meja kerja", "Whiteboard", "Interview" tinggal satu ketukan.
- **Telemetri langsung** dari `getStats()`: bitrate aktual, fps terkirim, RTT,
  packet loss, dan peringatan eksplisit saat encoder CPU-limited, WiFi tidak
  kuat, atau encoder-nya software (bukan hardware).
- Mic HP opsional (default off, untuk hindari echo). Menyalakannya **tidak**
  menyentuh track video — framing dan setelan pro tetap utuh.
- **Alat monitor kelas broadcast** (tab Monitor) — histogram luma/RGB, zebra
  70/95/100 IRE, focus peaking, false color, dan meter audio peak-hold dengan
  indikator clip. Semuanya digambar dari satu sampel 256×144 tiap 150 ms, dan
  **hanya di layar HP** — yang dikirim ke OBS tetap gambar bersih.
- Flash/torch (Android), indikator baterai, peringatan orientasi portrait
- Wake lock — layar tidak mati saat streaming
- Auto-reconnect signaling + ICE restart; boleh buka OBS dulu atau HP dulu
- Semua setelan tersimpan di `localStorage` — buka lagi, sudah sama persis

## Soal "kamera native HP"

Halaman web **tidak bisa** memakai hasil olahan aplikasi kamera bawaan
(XOS Camera / AI CAM / mode FILM / PORTRAIT / night mode). Mode-mode itu
post-processing proprietary di dalam APK kameranya, tidak pernah diekspos ke
aplikasi lain — bahkan app native pihak ketiga (Iriun, DroidCam, Camo) juga
tidak bisa, mereka sama-sama baca Camera2 API.

Yang *bisa* didekati dari browser sudah dipasang di panel **Kontrol kamera
(pro)**: lensa fisik (ultrawide/tele muncul sebagai device terpisah di
dropdown Kamera), zoom, fokus, eksposur, ISO, dan white balance — persis
parameter yang dipakai "mode Pro" di aplikasi kamera bawaan.

Kalau benar-benar butuh look AI CAM / night mode-nya, satu-satunya jalan
adalah menangkap layar HP: jalankan `scrcpy`, buka aplikasi kamera bawaan,
lalu ambil jendela scrcpy sebagai **Window Capture** di OBS. Konsekuensinya:
latency lebih tinggi, ada overlay UI kamera, dan resolusi mengikuti layar.

## Beberapa kamera sekaligus

Jalankan satu Browser Source per room (satu room = satu HP; sender kedua
di room yang sama akan ditolak server):

```
HP A → https://<IP>:8443/?room=cam1&k=<token>
HP B → https://<IP>:8443/?room=cam2&k=<token>
```

## Hardening

- HTTP (8080) **bind ke 127.0.0.1 saja** — tidak ada jalur plaintext ke LAN.
  Hanya HTTPS (8443) yang terbuka. Ubah dengan `HTTP_HOST=`.
- Token bersama pada semua `join` WebSocket, dibandingkan `timingSafeEqual`.
- Origin check saat upgrade WebSocket (halaman lain tidak bisa menyambung).
- Batas: payload 256 KB, 120 pesan/detik per socket, 8 peer/room, 32 room,
  1 sender per room. Pelanggar diputus dengan alasan yang eksplisit.
- Nama room divalidasi regex; static server menolak traversal, null byte, dan
  method selain GET/HEAD.
- Security header: CSP ketat (tanpa `unsafe-eval`, tanpa sumber eksternal),
  `nosniff`, `no-referrer`, `Permissions-Policy: camera=(self)`. Semua JS ada
  di file terpisah (tanpa inline script) supaya CSP bisa setegas ini.
- Heartbeat ping/pong 30 s membereskan socket mati supaya OBS cepat idle.
- Cert: EC P-256, key mode 600, SAN berisi semua IP LAN (dideteksi lewat Node,
  jalan di macOS & Linux). `npm run cert -- --force` untuk bikin ulang.

## Test

```bash
npm start                  # terminal 1
npm test                   # terminal 2 (signaling + E2E browser asli)
```

`test-sdp` dan `test-overlay` berjalan tanpa browser. `test-procontrol`
menjalankan dua HP tiruan — satu yang meng-echo `getSettings()` dan satu yang
tidak — untuk memastikan gerbang kontrol manual terbuka di keduanya. E2E menjalankan Chromium,
membuka halaman sender & OBS, dan memverifikasi frame video benar-benar
mengalir lewat WebRTC — termasuk bahwa menyalakan mic di tengah siaran
benar-benar sampai ke OBS (renegosiasi) dan video tidak ikut terputus. Kamera di-stub dengan
`canvas.captureStream()` karena mesin CI tidak punya kamera. Kalau Playwright
belum terpasang, E2E di-skip (bukan gagal).

## Troubleshooting

| Gejala | Sebab / solusi |
|---|---|
| Halaman bilang "Ditolak server: bad-token" | URL kurang `?k=...`. Salin ulang dari terminal PC. |
| "Ditolak server: sender-taken" | Room sudah dipakai tab/HP lain. Tutup yang lama atau pakai room lain. |
| HP: "Gagal buka kamera: NotAllowedError" | Halaman harus **https**. Terima dulu peringatan sertifikatnya, baru tekan Mulai kirim. |
| HP tidak bisa buka URL sama sekali | Firewall PC memblokir port 8443, atau HP di WiFi tamu / AP isolation aktif. |
| OBS hitam, HP bilang "Viewer tersambung: 1" | Jarang — biasanya autoplay. Refresh Browser Source (tombol *Refresh* di properties). |
| Video patah-patah | Turunkan ke 720p/30 atau bitrate 2 Mbps. WiFi 2.4 GHz sering tidak kuat 1080p60. |
| Streaming berhenti saat HP dikunci | iOS menghentikan kamera saat layar mati — biarkan layar menyala (wake lock sudah aktif, jangan tekan tombol power). |
| Delay besar (>1 detik) | Cek HP tidak jatuh ke jaringan seluler; keduanya harus di subnet yang sama. |
| Panel pro kosong | HP/browser itu tidak mengekspos kontrol manual apa pun. Chrome Android paling lengkap; Safari iOS hampir tidak ada. |
| Slider ISO/shutter redup | Normal — mode Eksposur masih otomatis. Ubah ke `manual` dulu; nilainya memang ditolak HP selama modenya auto. |
| Sudah `manual` tapi slider tetap redup | Panel akan menampilkan alasannya: lensa itu menolak mode manual. Sebagian HP hanya mendukungnya di lensa utama. |
| Panel bilang "tidak melaporkan ... kembali ke browser" | Wajar. HP itu menerapkan modenya tapi tidak meng-echo lewat `getSettings()`, jadi tidak bisa diverifikasi. Kontrolnya tetap terbuka dan dikirim. |
| Tombol hilang saat live | Chrome menyembunyikan diri setelah 4 detik. Ketuk layar. |
| Chip peringatan "encoder software" | HP tidak memakai encoder hardware untuk codec itu — ganti codec ke H.264 di tab Kirim. |
| HP panas / chip `CPU` terus menyala | Lihat bagian **Beban CPU & panas**. Paling sering: encoder software, atau 1080p60 di HP kelas menengah. |
| Tally tidak pernah menyala | Browser Source-nya bukan halaman `/obs` dari server ini, atau OBS-nya versi lama tanpa event `obsSourceActiveChanged`. Uji jalurnya tanpa OBS: buka `/obs?...&tally=program` di browser biasa. |
| Chip `REC`/`LIVE OBS` tidak muncul | Control level Browser Source masih di bawah READ_OBS. Tally program/preview tetap jalan. |
| Panel `/control` kosong | HP belum menekan "Mulai". Panel terisi sendiri begitu HP mengirim. |

## Batasan

- LAN saja (tanpa STUN/TURN). Untuk lintas jaringan, tambahkan STUN/TURN di
  `ICE_CONFIG` pada `public/signal.js`.
- Token adalah satu rahasia bersama, bukan per-user. Cukup untuk LAN rumah/
  kantor; bukan pengganti auth sungguhan kalau dipublikasikan.
- Efek/mode aplikasi kamera bawaan tidak bisa diakses (lihat bagian di atas).

## Tally & kendali dari PC

Dua hal yang membedakan kamera produksi dari kamera biasa, keduanya lewat satu
DataChannel di atas koneksi WebRTC yang sudah ada — tanpa port atau auth
tambahan.

**Tally.** Halaman OBS tahu kapan source-nya on-air; HP tidak. Tanpa jalur
balik, orang di balik kamera tidak punya cara tahu dia sedang disiarkan.
Halaman OBS mendengarkan `obsSourceActiveChanged` / `obsSourceVisibleChanged`
dan event streaming/recording dari `window.obsstudio`, lalu mengirimkannya ke
HP:

| Di HP | Artinya |
|---|---|
| Bingkai **merah tebal** + chip `ON AIR` berkedip | Source dipakai scene program |
| Bingkai **hijau** + chip `PREVIEW` | Terlihat di scene lain (studio mode) |
| Bingkai merah tipis | Mengirim, tapi OBS belum memberi tahu statusnya |
| Chip `REC` / `LIVE OBS` | OBS sedang merekam / streaming |

Tally tetap terbaca di mode blackout — titik merah besar di layar yang sengaja
digelapkan. Status disimpan per-viewer, jadi menutup satu Browser Source tidak
meninggalkan lampu ON AIR menyala.

Event source active/visible jalan di control level default Browser Source.
Status streaming/recording butuh level **READ_OBS** di properti source-nya;
tanpa itu sisanya tetap jalan.

**Panel kontrol.** Buka `/control` di browser PC. Halaman ini masuk ke room
sebagai viewer biasa — dapat video DAN kanal kontrol — lalu mengirim perintah
balik ke HP: zoom, eksposur, ISO, shutter, fokus, white balance, torch, kunci
AE/AF/WB, reset.

Gunanya sederhana tapi besar: HP nangkring di tripod seberang ruangan.
Menyetel apa pun dengan menyentuh HP berarti menggeser framing yang baru saja
susah payah diatur. Dari sini, tidak ada yang tersentuh.

Panelnya dibangun dari kode yang sama persis dengan panel di HP
(`procontrols.js`) — termasuk aturan gerbang mode manual — jadi keduanya tidak
akan pernah berbeda perilaku. Perubahan yang dilakukan langsung di HP juga
terpantul balik ke panel PC.

Perintah yang masuk divalidasi dengan daftar putih eksplisit (`link.js`);
tidak ada key sembarang yang diteruskan ke `applyConstraints`.

## Alat monitor

Layar HP tidak terkalibrasi, dan di bawah matahari semuanya terlihat gelap.
Alat di tab **Monitor** membuat eksposur dan fokus bisa dinilai dari angka,
bukan dari kesan:

| Alat | Untuk apa |
|---|---|
| **Histogram** | Luma atau RGB. Puncak menempel di kanan = highlight gosong; menempel di kiri = bayangan mati. |
| **Zebra 70** | Menandai kulit yang ter-ekspos benar. Atur sampai wajah baru mulai bergaris. |
| **Zebra 95 / 100** | Menandai highlight yang hampir / sudah clipping. |
| **Focus peaking** | Tepi tajam ditandai merah. Wajib saat fokus manual. |
| **False color** | Peta eksposur seluruh frame: biru terlalu gelap, hijau kulit, merah clipping. |
| **Meter audio** | Peak (bukan RMS) + peak hold 1,5 dtk + indikator clip. Yang merusak rekaman adalah puncaknya. |

Biayanya rata berapa pun yang dinyalakan: satu `getImageData` 256×144 tiap
150 ms memberi makan semuanya sekaligus. Loop-nya berhenti sendiri saat semua
alat dimatikan dan saat chrome menyembunyikan diri.

## Beban CPU & panas

HP yang panas akan throttle, dan encoder yang kehabisan CPU menjatuhkan
gambar. Empat hal yang dilakukan supaya itu tidak terjadi:

**Tidak ada yang bekerja untuk layar yang tidak dilihat.** Overlay dan meter
audio berhenti total saat mode gelap, saat chrome menyembunyikan diri, dan saat
tab ke background. Ini bukan sekadar disembunyikan lewat CSS — loop-nya benar
benar dihentikan, jadi tidak ada readback GPU dan tidak ada lintasan piksel.

**Mode gelap melepas preview.** `srcObject` dilepas, jadi render video
full-screen berhenti sepenuhnya. Track-nya terus jalan — OBS tidak terganggu
sama sekali. Ini penghematan terbesar yang tersedia di HP.

**Rem otomatis.** Saat `qualityLimitationReason` melaporkan `cpu` selama 5
detik berturut-turut, encoder direm bertahap: fps dibatasi 30, lalu skala
1,5×, lalu 2×. Semuanya lewat `setParameters` — **kamera tidak di-restart**,
jadi framing dan seluruh setelan pro tetap utuh. Rem dilepas lagi setelah 20
detik lega; pemulihan sengaja jauh lebih lambat daripada penurunan supaya
tidak berayun di ambang batas. Bisa dimatikan di tab Kirim.

**Buffer dipakai ulang.** Overlay dulu mengalokasikan ~1,2 MB per detik dan
GC-nya adalah persis jeda yang membuat encoder kehabisan jatah. Saat hanya
histogram yang menyala, pikselnya juga disubsampel seperempat.

### Kalau chip peringatan masih menyala

Baca `status` di tab Kirim — di sana ada diagnosisnya, bukan cuma gejalanya:

| Yang terbaca | Artinya |
|---|---|
| `Encoder: ... (SOFTWARE)` | Ini penyebab paling umum. HP meng-encode dengan CPU, bukan chip encoder. Ganti codec ke **H.264** di tab Kirim. |
| `Pembatas: cpu` + encoder hardware | Resolusi/fps terlalu tinggi untuk HP ini. Turun ke 1080p30 atau 720p60. |
| `Pembatas: bandwidth` | Bukan soal CPU — WiFi-nya. Turunkan bitrate. |
| `Dikirim: 960×540@30` padahal minta 1080p | Rem otomatis sedang bekerja. Itu memang yang diinginkan. |

Matikan juga alat monitor yang tidak sedang dipakai (tombol 📊). False color
dan focus peaking menyentuh setiap piksel sampel; histogram saja jauh lebih
murah.

## Latency & kualitas

Dua hal yang paling terasa, keduanya tidak kelihatan di UI:

- **Ramp-up bitrate.** `setParameters()` hanya punya `maxBitrate` — tidak ada
  knob start bitrate sama sekali. Tanpa `x-google-start-bitrate` di SDP, Chrome
  memulai dari ~300 kbps dan merangkak belasan detik ke target: sepuluh detik
  pertama tiap koneksi jelek, persis saat orang menekan record. `public/sdp.js`
  menyisipkan start/min/max bitrate ke offer lokal.
- **Jitter buffer.** Halaman OBS menyetel `jitterBufferTarget` (dan
  `playoutDelayHint` untuk CEF lama) ke 0 — di LAN, buffer default hanya delay
  yang terbuang. Naikkan lewat `?buffer=<ms>` kalau gambar mulai tersendat.

Audio mic dikirim Opus stereo 128 kbps dengan in-band FEC, bukan mono ~32 kbps
bawaan WebRTC.

## Struktur

```
server.js              HTTP(S) static + hub signaling WebSocket + auth/limit
public/index.html      markup halaman sender (HP)
public/ui.css          seluruh tampilan sender (landscape-first)
public/sender.js       perekat: UI, gestur, telemetri
public/camera.js       getUserMedia, kapabilitas, constraint bergerbang mode
public/transport.js    peer per viewer: codec, bitrate, renegosiasi, getStats
public/sdp.js          munging SDP (start/min/max bitrate, Opus stereo)
public/overlay.js      histogram, zebra, peaking, false color, garis bantu, VU
public/procontrols.js  panel kontrol pro, dipakai halaman HP & PC
public/link.js         protokol DataChannel: tally + perintah kamera
public/control.html    markup panel kontrol di PC
public/control.js      logika panel kontrol: terima state, kirim perintah
public/store.js        persistensi setelan + Look di localStorage
public/obs.html        markup halaman receiver (OBS Browser Source)
public/receiver.js     logika receiver: terima track, jitter buffer, HUD
public/signal.js       klien signaling + konfigurasi ICE
scripts/gen-cert.sh    sertifikat self-signed (SAN = semua IP LAN)
scripts/chromium.mjs   pencari Playwright, dipakai bersama test browser
scripts/test-sdp.mjs, test-overlay.mjs, test-signal.mjs,
scripts/test-e2e.mjs, test-procontrol.mjs, test-control.mjs,
scripts/test-power.mjs
certs/token            token room (auto-generate, jangan di-commit)
```
