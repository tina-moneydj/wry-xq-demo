#!/usr/bin/env bash
# Cross-build (Linux → Windows gnu) or use a prebuilt MSVC exe, stage payload, compile Inno Setup.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGING="$ROOT/installer/staging"
DIST="$ROOT/dist"
ISS="$ROOT/installer/wry-xq-demo.iss"
TARGET_TRIPLE="${XQ_WIN_TARGET:-x86_64-pc-windows-gnu}"
WINEPREFIX="${WINEPREFIX:-/workspace/xq-installer/wine-inno}"
ISCC="${ISCC:-$WINEPREFIX/drive_c/InnoSetup/ISCC.exe}"

mkdir -p "$STAGING" "$DIST"
rm -rf "${STAGING:?}/"*
mkdir -p "$STAGING"

echo "==> Building release for $TARGET_TRIPLE"
export PATH="${HOME}/.cargo/bin:${PATH}"
if [[ "$TARGET_TRIPLE" == *windows-gnu ]]; then
  if command -v update-alternatives >/dev/null 2>&1; then
    sudo update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-win32 2>/dev/null || true
    sudo update-alternatives --set x86_64-w64-mingw32-g++ /usr/bin/x86_64-w64-mingw32-g++-win32 2>/dev/null || true
  fi
fi

if [[ "${XQ_SKIP_BUILD:-0}" != "1" ]]; then
  rustup target add "$TARGET_TRIPLE" >/dev/null
  (cd "$ROOT" && cargo build --release --target "$TARGET_TRIPLE")
fi

EXE="$ROOT/target/$TARGET_TRIPLE/release/wry-xq-demo.exe"
if [[ ! -f "$EXE" ]]; then
  echo "ERROR: missing $EXE" >&2
  echo "On Windows (preferred MSVC): cargo build --release --target x86_64-pc-windows-msvc" >&2
  echo "Then: XQ_SKIP_BUILD=1 XQ_WIN_TARGET=x86_64-pc-windows-msvc $0" >&2
  exit 1
fi

cp -f "$EXE" "$STAGING/wry-xq-demo.exe"

LOADER=""
if [[ -f "$ROOT/target/$TARGET_TRIPLE/release/WebView2Loader.dll" ]]; then
  LOADER="$ROOT/target/$TARGET_TRIPLE/release/WebView2Loader.dll"
else
  LOADER="$(find "$HOME/.cargo/registry/src" -path '*/webview2-com-sys-*/x64/WebView2Loader.dll' 2>/dev/null | sort -V | tail -1 || true)"
fi
if [[ -z "$LOADER" || ! -f "$LOADER" ]]; then
  echo "ERROR: WebView2Loader.dll not found (expected via webview2-com-sys crate)." >&2
  exit 1
fi
cp -f "$LOADER" "$STAGING/WebView2Loader.dll"

cat > "$STAGING/README.txt" << 'TXT'
XQ Style Demo (wry-xq-demo) / XQ 風格測試
========================================

Requirements:
- Windows 10/11 x64
- Microsoft Edge WebView2 Runtime (usually preinstalled)

Run:
- Double-click wry-xq-demo.exe

Notes:
- Bottom-right web tab defaults to blank (about:blank); no external site on startup.
- For live XQNext quotes, build feedhost separately (see feedhost/README.md).
TXT

echo "==> Staged:"
ls -lh "$STAGING"

if [[ ! -f "$ISCC" ]]; then
  echo "WARN: ISCC not found at $ISCC — staging only. Install Inno Setup or set WINEPREFIX/ISCC." >&2
  exit 0
fi

echo "==> Compiling Inno Setup with Wine ($WINEPREFIX)"
export WINEPREFIX
export WINEDEBUG="${WINEDEBUG:--all}"
# Convert Unix path to Wine Z:\...
ISS_WIN="Z:${ISS//\//\\}"
wine "$ISCC" "$ISS_WIN" 2>&1 | tee "$DIST/inno-build.log"
ls -lh "$DIST"/wry-xq-demo-setup-*.exe 2>/dev/null || {
  echo "ERROR: installer exe not produced; see $DIST/inno-build.log" >&2
  exit 1
}
echo "==> Done."
