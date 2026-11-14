#!/bin/bash
# Run the shared-logic unit tests (host platform, no simulator needed).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=$(mktemp -d "${TMPDIR:-/tmp}/hemi-dsh-mobile-tests.XXXXXX")
printf 'Test scratch directory: %s\n' "$OUT"
exec swift test --scratch-path "$OUT"
