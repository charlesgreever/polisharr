#!/bin/sh
# Native macOS process. Docker Desktop, Colima, and Lima run Linux VMs, so
# those containers cannot call VideoToolbox (the Apple media engine).
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script runs on macOS so ffmpeg can use the Apple media engine." >&2
  exit 1
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

need() {
  bin=$1
  formula=$2
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Install ${bin} first (Homebrew: brew install ${formula})." >&2
    exit 1
  fi
}

need node node
need ffmpeg ffmpeg
need ffprobe ffmpeg
need mkvmerge mkvtoolnix

if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'hevc_videotoolbox'; then
  echo "ffmpeg on this Mac does not list hevc_videotoolbox. Install Homebrew ffmpeg." >&2
  exit 1
fi

if [ ! -f dist/server.js ]; then
  echo "Building Polisharr because dist/server.js is missing."
  npm ci
  npm run build
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-7373}"
export CONFIG_DIR="${CONFIG_DIR:-${root}/config}"
export FFMPEG="${FFMPEG:-$(command -v ffmpeg)}"
export FFPROBE="${FFPROBE:-$(command -v ffprobe)}"
export MKVMERGE="${MKVMERGE:-$(command -v mkvmerge)}"

chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon")
echo "Polisharr using ${FFMPEG} on ${chip}."
exec node dist/server.js
