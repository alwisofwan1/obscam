#!/usr/bin/env bash
# Bikin self-signed cert (SAN = semua IP LAN mesin ini) untuk halaman sender.
# getUserMedia di HP cuma jalan di secure context, jadi halaman kamera WAJIB https.
#
# Cross-platform: daftar IP diambil lewat Node (os.networkInterfaces), bukan
# `hostname -I` yang cuma ada di Linux.
set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=0
[[ "${1:-}" == "--force" || "${1:-}" == "-f" ]] && FORCE=1

if [[ -f certs/cert.pem && -f certs/key.pem && $FORCE -eq 0 ]]; then
  echo "certs/ sudah ada. Pakai '--force' untuk bikin ulang."
  openssl x509 -in certs/cert.pem -noout -subject -enddate -ext subjectAltName
  exit 0
fi

command -v openssl >/dev/null || { echo "openssl tidak ditemukan"; exit 1; }
command -v node    >/dev/null || { echo "node tidak ditemukan"; exit 1; }

mkdir -p certs
chmod 700 certs

IPS="$(node -e '
const os = require("node:os");
const ips = Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === "IPv4" && !i.internal)
  .map(i => i.address);
console.log([...new Set(ips)].join(" "));
')"

SAN="DNS:localhost,DNS:$(hostname -s 2>/dev/null || echo obscam).local,IP:127.0.0.1"
for ip in $IPS; do SAN="$SAN,IP:$ip"; done
echo "SAN: $SAN"
[[ -z "$IPS" ]] && echo "!! Tidak ada IP LAN terdeteksi — HP mungkin tidak bisa konek."

# EC P-256: lebih cepat handshake-nya di HP kelas menengah daripada RSA-2048,
# dan didukung semua browser modern. 825 hari = batas maksimum yang diterima
# browser untuk sertifikat baru.
umask 077
openssl req -x509 -nodes -days 825 \
  -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=obscam" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null

chmod 600 certs/key.pem
chmod 644 certs/cert.pem

echo "-> certs/cert.pem + certs/key.pem (key mode 600)"
echo
echo "Fingerprint (cocokkan dengan yang ditampilkan browser HP saat warning):"
openssl x509 -in certs/cert.pem -noout -fingerprint -sha256
