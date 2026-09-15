// Utilitas SDP. Sengaja tanpa import apa pun supaya bisa diuji langsung di
// Node tanpa DOM.
//
// setParameters() hanya punya maxBitrate — tidak ada knob untuk start bitrate
// sama sekali. Tanpa x-google-start-bitrate, Chrome memulai dari ~300 kbps dan
// merangkak belasan detik ke target: sepuluh detik pertama tiap koneksi jelek,
// persis saat orang menekan record.

function mediaSections(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('m=')) continue;
    const kind = lines[i].slice(2).split(' ')[0];
    let end = i + 1;
    while (end < lines.length && !lines[end].startsWith('m=')) end++;
    out.push({ kind, start: i, end });
  }
  return out;
}

function upsertFmtp(lines, pt, params) {
  const idx = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
  if (idx >= 0) {
    const existing = lines[idx].slice(`a=fmtp:${pt} `.length);
    const keys = new Set(params.map((p) => p.split('=')[0]));
    const kept = existing.split(';').filter((p) => p && !keys.has(p.split('=')[0]));
    lines[idx] = `a=fmtp:${pt} ${[...kept, ...params].join(';')}`;
    return;
  }
  const rtpmap = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
  if (rtpmap >= 0) lines.splice(rtpmap + 1, 0, `a=fmtp:${pt} ${params.join(';')}`);
}

/**
 * Sisipkan hint bitrate ke SDP lokal.
 * min ditahan tidak terlalu rendah supaya estimator tidak menjatuhkan kualitas
 * berlebihan saat ada burst kecil di WiFi; ini LAN, bukan jaringan seluler.
 */
export function mungeSdp(sdp, { maxBitrate, audioBitrate = 128000 }) {
  const lines = sdp.split('\r\n');
  const maxKbps = Math.round(maxBitrate / 1000);
  const startKbps = Math.round(maxKbps * 0.8);
  const minKbps = Math.round(maxKbps * 0.35);

  // Dua lintasan. Lintasan pertama hanya MEMBACA: menyisipkan baris fmtp
  // sambil menelusuri akan menggeser indeks m-section berikutnya dan merusak
  // SDP-nya. Payload type unik satu SDP (semua m-line di-BUNDLE), jadi aman
  // dicari global saat menulis.
  const work = [];
  for (const sec of mediaSections(lines)) {
    for (let i = sec.start; i < sec.end; i++) {
      if (sec.kind === 'video') {
        const m = /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i.exec(lines[i]);
        if (m) work.push([m[1], [
          `x-google-start-bitrate=${startKbps}`,
          `x-google-min-bitrate=${minKbps}`,
          `x-google-max-bitrate=${maxKbps}`,
        ]]);
      } else if (sec.kind === 'audio') {
        const m = /^a=rtpmap:(\d+) opus\//i.exec(lines[i]);
        // Default Opus di WebRTC mono ~32 kbps. Untuk sumber produksi itu
        // terlalu hemat; naikkan dan buka stereo.
        if (m) work.push([m[1], [
          'stereo=1',
          'sprop-stereo=1',
          'useinbandfec=1',
          `maxaveragebitrate=${audioBitrate}`,
        ]]);
      }
    }
  }

  for (const [pt, params] of work) upsertFmtp(lines, pt, params);
  return lines.join('\r\n');
}

