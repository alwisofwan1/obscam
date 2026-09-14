#!/usr/bin/env bash
# Bikin self-signed cert (SAN = semua IP LAN mesin ini) untuk halaman sender.
# getUserMedia di HP cuma jalan di secure context, jadi halaman kamera WAJIB https.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs

SAN="DNS:localhost,IP:127.0.0.1"
for ip in $(hostname -I 2>/dev/null || true); do SAN="$SAN,IP:$ip"; done
echo "SAN: $SAN"

openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=obscam" \
  -addext "subjectAltName=$SAN"

echo "-> certs/cert.pem + certs/key.pem"
