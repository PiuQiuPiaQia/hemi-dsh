#!/bin/bash
# Orchestrate the WKWebView self-signed trust experiment end to end.
#
# 1. Generate a throwaway self-signed leaf (SAN 127.0.0.1).
# 2. Serve assets over HTTPS from 127.0.0.1:8443.
# 3. Build the minimal WKWebView client and run it twice:
#    - mode=pin      (correct pin; expect main frame accepted)
#    - mode=wrongpin (flipped pin; expect fail-closed navigation)
# 4. Write logs under results/ and print a compact verdict.

set -euo pipefail
cd "$(dirname "$0")"

ROOT=$PWD
BUILD=$(mktemp -d "${TMPDIR:-/tmp}/wk-tls-trust.XXXXXX")  # APFS: exFAT breaks codesign via AppleDouble files
RESULTS=$ROOT/results
PORT=8443
rm -rf "$RESULTS"
mkdir -p "$RESULTS"

# --- certificate ---------------------------------------------------------
openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
  -keyout "$BUILD/key.pem" -out "$BUILD/cert.pem" \
  -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
PIN=$(openssl x509 -in "$BUILD/cert.pem" -outform DER | openssl dgst -sha256 -hex | awk '{print $2}')
echo "RUN pin=$PIN"

# --- assets that are generated, not checked in ---------------------------
python3 - "$ROOT/assets" <<'PY'
import base64
import os
import sys
root = sys.argv[1]
# 1x1 red PNG
png = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)
with open(os.path.join(root, "img.png"), "wb") as handle:
    handle.write(png)
PY
cp ../../../../packages/client/ui-theme/src/styles/montserrat-regular.woff2 assets/font.woff2

# --- server --------------------------------------------------------------
python3 server.py "$BUILD/cert.pem" "$BUILD/key.pem" "$PORT" > "$RESULTS/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  if grep -q "listening" "$RESULTS/server.log" 2>/dev/null; then break; fi
  sleep 0.2
done
grep -q "listening" "$RESULTS/server.log" || { echo "server failed to start"; cat "$RESULTS/server.log"; exit 1; }

# --- client build --------------------------------------------------------
mkdir -p "$BUILD/WKTLSTrust.app/Contents/MacOS"
swiftc -O -o "$BUILD/WKTLSTrust.app/Contents/MacOS/WKTLSTrust" main.swift
codesign --force -s - "$BUILD/WKTLSTrust.app" >/dev/null 2>&1

run_client() {
  local mode=$1
  local log=$2
  "$BUILD/WKTLSTrust.app/Contents/MacOS/WKTLSTrust" "origin=https://127.0.0.1:$PORT" "pin=$PIN" "mode=$mode" > "$log" 2>&1 || true
}

run_client pin "$RESULTS/client-pin.log"
run_client wrongpin "$RESULTS/client-wrongpin.log"

kill "$SERVER_PID" 2>/dev/null || true
trap - EXIT

# --- verdict -------------------------------------------------------------
echo
echo "=== client-pin.log ==="
cat "$RESULTS/client-pin.log"
echo
echo "=== client-wrongpin.log ==="
cat "$RESULTS/client-wrongpin.log"
echo
echo "=== server.log (request order) ==="
grep -E "SERVER request|SERVER ws" "$RESULTS/server.log" || true
