#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor/voicebox"
VENV_DIR="$ROOT_DIR/.venv-voicebox"
DATA_DIR="$ROOT_DIR/data"
MODELS_DIR="$DATA_DIR/models"
PORT="${VOICEBOX_PORT:-17493}"
HOST="${VOICEBOX_HOST:-127.0.0.1}"
VOICEBOX_MAIN="$VENDOR_DIR/backend/main.py"
VOICEBOX_REQUIREMENTS="$VENDOR_DIR/backend/requirements.txt"

resolve_venv_python() {
  if [ -x "$VENV_DIR/Scripts/python.exe" ]; then
    printf '%s\n' "$VENV_DIR/Scripts/python.exe"
    return 0
  fi
  if [ -x "$VENV_DIR/bin/python" ]; then
    printf '%s\n' "$VENV_DIR/bin/python"
    return 0
  fi
  return 1
}

VENV_PYTHON="$(resolve_venv_python || true)"
if [ -z "$VENV_PYTHON" ]; then
  echo "[voicebox] missing venv: $VENV_DIR"
  echo "Run setup first: $ROOT_DIR/scripts/setup_voicebox_backend.sh"
  exit 1
fi

if [ ! -f "$VOICEBOX_MAIN" ] || [ ! -f "$VOICEBOX_REQUIREMENTS" ]; then
  echo "[voicebox] backend source incomplete"
  echo "[voicebox] expected: $VOICEBOX_MAIN"
  echo "[voicebox] expected: $VOICEBOX_REQUIREMENTS"
  echo "Run setup first: $ROOT_DIR/scripts/setup_voicebox_backend.sh"
  exit 1
fi

export PYTHONPATH="$VENDOR_DIR:${PYTHONPATH:-}"
export VOICEBOX_DATA_DIR="$DATA_DIR"
export VOICEBOX_MODELS_DIR="$MODELS_DIR"
export PYTHONUNBUFFERED=1
mkdir -p "$DATA_DIR" "$MODELS_DIR" "$DATA_DIR/profiles" "$DATA_DIR/generations" "$DATA_DIR/cache"
cd "$ROOT_DIR"
exec "$VENV_PYTHON" -u -m backend.main --host "$HOST" --port "$PORT" --data-dir "$DATA_DIR"
