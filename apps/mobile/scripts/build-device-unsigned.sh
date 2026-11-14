#!/bin/bash
# Compile for generic iOS device hardware, unsigned. Evidence that the target
# builds for real devices; installing requires a signed build (see README).
set -euo pipefail
cd "$(dirname "$0")/../ios/App"
OUT=$(mktemp -d "${TMPDIR:-/tmp}/hemi-dsh-mobile-build.XXXXXX")
mkdir -p "$OUT/sym" "$OUT/obj"
echo "Build products: $OUT/sym"
xcodebuild \
  -project App.xcodeproj \
  -target HemiDSH \
  -sdk iphoneos \
  SUPPORTED_PLATFORMS=iphoneos \
  SYMROOT="$OUT/sym" \
  OBJROOT="$OUT/obj" \
  CODE_SIGNING_ALLOWED=NO \
  build
APP=$(find "$OUT/sym" -maxdepth 2 -name "HemiDSH.app" -print -quit)
echo "Built: $APP"
