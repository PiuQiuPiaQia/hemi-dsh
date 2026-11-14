#!/bin/bash
# Build the iOS app for the simulator SDK. This host has no simulator runtime,
# so destination-based builds are unavailable; the legacy target build compiles
# every source and links the app. Products stay in a fresh /tmp directory
# (APFS); the workspace volume is exFAT and must not hold build output.
set -euo pipefail
cd "$(dirname "$0")/../ios/App"
OUT=$(mktemp -d "${TMPDIR:-/tmp}/hemi-dsh-mobile-build.XXXXXX")
mkdir -p "$OUT/sym" "$OUT/obj"
echo "Build products: $OUT/sym"
xcodebuild \
  -project App.xcodeproj \
  -target HemiDSH \
  -sdk iphonesimulator \
  SUPPORTED_PLATFORMS=iphonesimulator \
  SYMROOT="$OUT/sym" \
  OBJROOT="$OUT/obj" \
  CODE_SIGNING_ALLOWED=NO \
  build
APP=$(find "$OUT/sym" -maxdepth 2 -name "HemiDSH.app" -print -quit)
echo "Built: $APP"
