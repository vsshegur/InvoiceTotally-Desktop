#!/usr/bin/env bash
# Builds build/InvoiceTotally-<version>-Setup.exe
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
cp assets/InvoiceTotally.ico "$STAGE/"
cp "$NODE_EXE" "$STAGE/runtime/node.exe"
cp package.json "$STAGE/app/"
cp desktop/*.mjs desktop/config.json "$STAGE/app/desktop/"
cp -r engine public "$STAGE/app/"
PY=$(command -v python3 || command -v python)
"$PY" - "$STAGE" windows/setup/payload.zip <<'PYEOF'
import sys, os, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _, files in os.walk(stage):
        for f in sorted(files):
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, stage).replace(os.sep, "/"))
PYEOF
echo "$VERSION" > windows/setup/version.txt
( cd windows && go build -trimpath -ldflags "-s -w -H=windowsgui" -o "../build/InvoiceTotally-$VERSION-Setup.exe" ./setup )
# a console build of Setup for automated checks (--quiet prints instead of showing message boxes)
( cd windows && go build -trimpath -ldflags "-s -w" -o "../build/setup-console.exe" ./setup )
ls -la build/*.exe
