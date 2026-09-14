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

Server mencetak dua URL:

| Untuk | URL |
|---|---|
| HP (sender) | `https://<IP-PC>:8443/?room=default` |
| OBS (receiver) | `http://localhost:8080/obs?room=default` |

## Setup OBS

1. **Sources → + → Browser**
2. URL: `http://localhost:8080/obs?room=default&nohud=1`
3. Width/Height: `1920` × `1080`
4. Centang **Control audio via OBS** (kalau mic HP dipakai)
5. Jangan centang "Shutdown source when not visible" — bikin reconnect terus

Di HP: buka URL https, terima peringatan sertifikat (**Advanced → Proceed**),
izinkan akses kamera, tekan **Mulai kirim**.

### Parameter URL halaman OBS

| Param | Arti |
|---|---|
| `room=xxx` | Pisahkan beberapa HP/scene. Sender & receiver harus sama. |
| `nohud=1` | Sembunyikan teks "Menunggu kamera HP…" |
| `fit=cover` | Crop penuh layar (default `contain` = letterbox) |

## Fitur sender

- Pilih kamera (depan/belakang/ultrawide/tele — semua yang diekspos HP)
- Resolusi 720p–4K, 24/30/60 fps, bitrate 2–12 Mbps
- Mic HP opsional (default off, untuk hindari echo)
- Flash/torch (Android)
- Wake lock — layar tidak mati saat streaming
- Auto-reconnect signaling; boleh buka OBS dulu atau HP dulu

## Beberapa kamera sekaligus

Jalankan satu Browser Source per room:

```
HP A → https://<IP>:8443/?room=cam1   →  OBS source http://localhost:8080/obs?room=cam1
HP B → https://<IP>:8443/?room=cam2   →  OBS source http://localhost:8080/obs?room=cam2
```

## Test

```bash
npm start                  # terminal 1
npm test                   # terminal 2 (signaling + E2E browser asli)
```

E2E menjalankan Chrome headless, membuka halaman sender & OBS, dan
memverifikasi frame video benar-benar mengalir lewat WebRTC. Kamera di-stub
dengan `canvas.captureStream()` karena mesin CI tidak punya kamera.

## Troubleshooting

| Gejala | Sebab / solusi |
|---|---|
| HP: "Gagal buka kamera: NotAllowedError" | Halaman harus **https**. Terima dulu peringatan sertifikatnya, baru tekan Mulai kirim. |
| HP tidak bisa buka URL sama sekali | Firewall PC memblokir port 8443, atau HP di WiFi tamu / AP isolation aktif. |
| OBS hitam, HP bilang "Viewer tersambung: 1" | Jarang — biasanya autoplay. Refresh Browser Source (tombol *Refresh* di properties). |
| Video patah-patah | Turunkan ke 720p/30 atau bitrate 2 Mbps. WiFi 2.4 GHz sering tidak kuat 1080p60. |
| Streaming berhenti saat HP dikunci | iOS menghentikan kamera saat layar mati — biarkan layar menyala (wake lock sudah aktif, jangan tekan tombol power). |
| Delay besar (>1 detik) | Cek HP tidak jatuh ke jaringan seluler; keduanya harus di subnet yang sama. |

## Batasan

- LAN saja (tanpa STUN/TURN). Untuk lintas jaringan, tambahkan STUN/TURN di
  `ICE_CONFIG` pada `public/signal.js`.
- Tanpa autentikasi — siapa pun di LAN yang tahu room bisa ikut mengintip.
  Pakai nama room acak kalau jaringannya ramai.
- Video sender belum dikunci codec; Chrome/Safari biasanya memilih H.264/VP8
  secara otomatis.

## Struktur

```
server.js              HTTP(S) static + hub signaling WebSocket
public/index.html      halaman sender (HP)
public/obs.html        halaman receiver (OBS Browser Source)
public/signal.js       klien signaling + konfigurasi ICE
scripts/gen-cert.sh    sertifikat self-signed (SAN = semua IP LAN)
scripts/test-signal.mjs, scripts/test-e2e.mjs
```
