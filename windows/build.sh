#!/usr/bin/env bash
# Builds build/Vipul-Workplace-<version>-Setup.exe
#   windows/build.sh <path to Windows node.exe>
# Works on Linux (cross-compiles) and on Windows (Git Bash). Needs Go and python3/python (for zipping).
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_EXE="${1:?give the path to a Windows x64 node.exe (22.13 or newer)}"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
STAGE=build/stage
rm -rf "$STAGE" && mkdir -p "$STAGE/runtime" "$STAGE/app/desktop" build
export GOOS=windows GOARCH=amd64 CGO_ENABLED=0
( cd windows && go build -trimpath -ldflags "-s -w -H=windowsgui" -o "../$STAGE/InvoiceTotally.exe" ./launcher \
  && go build -trimpath -ldflags "-s -w -H=windowsgui" -o "../$STAGE/Uninstall InvoiceTotally.exe" ./uninstall )
# Create updated VW icon while preserving the legacy filename in existing installations.
PY=$(command -v python3 || command -v python)
"$PY" windows/make-icon.py "$STAGE/InvoiceTotally.ico"
cp "$NODE_EXE" "$STAGE/runtime/node.exe"
cp package.json "$STAGE/app/"
cp desktop/*.mjs desktop/config.json "$STAGE/app/desktop/"
cp -r engine public "$STAGE/app/"
# The payload is one stored zip, compressed as a single LZMA stream (windows/setup/lzma.go unpacks it): about a third
# smaller than compressing each file with deflate.
"$PY" - "$STAGE" windows/setup/payload.lzma <<'PYEOF'
import sys, os, io, zipfile, lzma
stage, out = sys.argv[1], sys.argv[2]
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
    for root, _, files in os.walk(stage):
        for f in sorted(files):
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, stage).replace(os.sep, "/"))
raw = buf.getvalue()
packed = lzma.compress(raw, format=lzma.FORMAT_ALONE, filters=[{"id": lzma.FILTER_LZMA1, "preset": 9, "dict_size": 1 << 27}])
open(out, "wb").write(packed)
print("payload: %.1f MB -> %.1f MB" % (len(raw) / 1e6, len(packed) / 1e6))
PYEOF
echo "$VERSION" > windows/setup/version.txt
( cd windows && go build -trimpath -ldflags "-s -w -H=windowsgui" -o "../build/Vipul-Workplace-$VERSION-Setup.exe" ./setup )
# a console build of Setup for automated checks (--quiet prints instead of showing message boxes)
( cd windows && go build -trimpath -ldflags "-s -w" -o "../build/setup-console.exe" ./setup )
ls -la build/*.exe
