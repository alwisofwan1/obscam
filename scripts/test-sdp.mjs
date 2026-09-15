// Unit test mungeSdp(). Tanpa browser: ini murni manipulasi teks, dan bug di
// sini tidak kelihatan sampai gambar diam-diam jelek sepuluh detik pertama.
import { mungeSdp } from '../public/sdp.js';

const log = [];
const check = (name, ok) => log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);

// Bentuk SDP Chrome yang disederhanakan: audio duluan, video menyusul, dengan
// fmtp yang sudah ada maupun yang belum. Urutan ini yang dulu merusak munging —
// menyisipkan baris di section audio menggeser indeks section video.
const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 H264/90000',
  'a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  '',
].join('\r\n');

const out = mungeSdp(SDP, { maxBitrate: 8_000_000, audioBitrate: 128000 });
const lines = out.split('\r\n');
const fmtp = (pt) => lines.find((l) => l.startsWith(`a=fmtp:${pt} `)) ?? '';

check('CRLF dipertahankan', out.includes('\r\n') && !/[^\r]\n/.test(out));
check('baris tidak hilang/berkurang', lines.length >= SDP.split('\r\n').length);

// Video: fmtp baru (VP8 belum punya) dan fmtp yang sudah ada (H264) sama-sama
// harus dapat ketiga hint, dengan parameter aslinya tetap utuh.
check('VP8 dapat start-bitrate', fmtp(96).includes('x-google-start-bitrate=6400'));
check('VP8 dapat min-bitrate', fmtp(96).includes('x-google-min-bitrate=2800'));
check('VP8 dapat max-bitrate', fmtp(96).includes('x-google-max-bitrate=8000'));
check('H264 dapat hint bitrate', fmtp(98).includes('x-google-start-bitrate=6400'));
check('H264 fmtp lama tetap utuh', fmtp(98).includes('profile-level-id=42e01f'));

// Yang BUKAN codec video utama tidak boleh disentuh.
check('rtx tidak disentuh', fmtp(97) === 'a=fmtp:97 apt=96');

// Audio: opus dinaikkan, parameter lama dipertahankan, tidak dobel.
check('opus stereo', fmtp(111).includes('stereo=1'));
check('opus bitrate', fmtp(111).includes('maxaveragebitrate=128000'));
check('opus minptime dipertahankan', fmtp(111).includes('minptime=10'));
check('useinbandfec tidak dobel', fmtp(111).match(/useinbandfec/g).length === 1);
check('red tidak disentuh', !lines.some((l) => l.startsWith('a=fmtp:63')));

// Idempoten: renegosiasi memunging ulang SDP yang sudah dimunging.
const twice = mungeSdp(out, { maxBitrate: 8_000_000, audioBitrate: 128000 });
check('idempoten', twice === out);

// Nilai berubah harus menimpa, bukan menumpuk.
const lower = mungeSdp(out, { maxBitrate: 2_000_000, audioBitrate: 128000 });
const lowVp8 = lower.split('\r\n').find((l) => l.startsWith('a=fmtp:96 '));
check('bitrate baru menimpa yang lama',
  lowVp8.includes('x-google-max-bitrate=2000') && !lowVp8.includes('x-google-max-bitrate=8000'));

// SDP tanpa m=audio (mic off) tidak boleh error.
const videoOnly = mungeSdp(SDP.split('m=audio')[0] + SDP.split(/m=video/)[1].replace(/^/, 'm=video'), { maxBitrate: 4_000_000 });
check('video-only tidak error', typeof videoOnly === 'string');

console.log(log.join('\n'));
process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
