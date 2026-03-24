#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor/voicebox"
VENV_DIR="$ROOT_DIR/.venv-voicebox"
PYTHON_BIN="${PYTHON_BIN:-python3.11}"
VOICEBOX_MAIN="$VENDOR_DIR/backend/main.py"
VOICEBOX_REQUIREMENTS="$VENDOR_DIR/backend/requirements.txt"
VOICEBOX_MLX_REQUIREMENTS="$VENDOR_DIR/backend/requirements-mlx.txt"
VOICEBOX_GIT_URL="https://github.com/jamiepine/voicebox.git"
VOICEBOX_ZIP_URL="https://codeload.github.com/jamiepine/voicebox/zip/refs/heads/main"
VOICEBOX_ZIP_PATH="$ROOT_DIR/vendor/.voicebox-source.zip"
VOICEBOX_TMP_DIR="$ROOT_DIR/vendor/.voicebox-download"

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

voicebox_repo_complete() {
  [ -f "$VOICEBOX_MAIN" ] && [ -f "$VOICEBOX_REQUIREMENTS" ]
}

download_voicebox_zip() {
  local target_dir="${1:-$VENDOR_DIR}"
  echo "[voicebox] downloading source archive..."
  rm -rf "$VOICEBOX_TMP_DIR" "$VOICEBOX_ZIP_PATH" "$target_dir"
  "$PYTHON_BIN" - "$VOICEBOX_ZIP_URL" "$VOICEBOX_ZIP_PATH" "$VOICEBOX_TMP_DIR" "$target_dir" <<'PY'
import pathlib
import shutil
import sys
import urllib.request
import zipfile

url, zip_path, extract_dir, vendor_dir = sys.argv[1:]
zip_target = pathlib.Path(zip_path)
extract_target = pathlib.Path(extract_dir)
vendor_target = pathlib.Path(vendor_dir)

zip_target.parent.mkdir(parents=True, exist_ok=True)
extract_target.mkdir(parents=True, exist_ok=True)

with urllib.request.urlopen(url, timeout=60) as response:
    zip_target.write_bytes(response.read())

with zipfile.ZipFile(zip_target, 'r') as archive:
    archive.extractall(extract_target)

entries = [entry for entry in extract_target.iterdir() if entry.is_dir()]
if not entries:
    raise SystemExit("[voicebox] archive extraction produced no directory")

source_dir = entries[0]
if vendor_target.exists():
    shutil.rmtree(vendor_target, ignore_errors=True)
shutil.move(str(source_dir), str(vendor_target))
PY
  rm -rf "$VOICEBOX_TMP_DIR" "$VOICEBOX_ZIP_PATH"
}

stage_voicebox_repo() {
  local stage_dir="$1"
  rm -rf "$stage_dir"
  if command -v git >/dev/null 2>&1; then
    echo "[voicebox] cloning source repo..."
    if git clone --depth 1 "$VOICEBOX_GIT_URL" "$stage_dir"; then
      return 0
    fi
    echo "[voicebox] git clone failed, falling back to source archive."
  else
    echo "[voicebox] git not found, falling back to source archive."
  fi
  download_voicebox_zip "$stage_dir"
}

refresh_voicebox_repo() {
  local stage_dir="$ROOT_DIR/vendor/.voicebox-stage.$$"
  rm -rf "$stage_dir" "$VOICEBOX_TMP_DIR" "$VOICEBOX_ZIP_PATH"
  if ! stage_voicebox_repo "$stage_dir"; then
    rm -rf "$stage_dir" "$VOICEBOX_TMP_DIR" "$VOICEBOX_ZIP_PATH"
    return 1
  fi
  if ! "$PYTHON_BIN" - "$stage_dir" "$VENDOR_DIR" <<'PY'
import pathlib
import shutil
import sys

stage_dir = pathlib.Path(sys.argv[1])
vendor_dir = pathlib.Path(sys.argv[2])

def remove_path(target: pathlib.Path) -> None:
    try:
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target, ignore_errors=True)
        else:
            target.unlink(missing_ok=True)
    except OSError:
        pass

def copy_path(source: pathlib.Path, target: pathlib.Path) -> None:
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

vendor_dir.mkdir(parents=True, exist_ok=True)
for child in list(vendor_dir.iterdir()):
    if child.name == '.git':
        continue
    remove_path(child)

for child in stage_dir.iterdir():
    if child.name == '.git':
        continue
    target = vendor_dir / child.name
    remove_path(target)
    copy_path(child, target)
PY
  then
    rm -rf "$stage_dir" "$VOICEBOX_TMP_DIR" "$VOICEBOX_ZIP_PATH"
    return 1
  fi
  rm -rf "$stage_dir" "$VOICEBOX_TMP_DIR" "$VOICEBOX_ZIP_PATH"
}

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python not found: $PYTHON_BIN"
  echo "Try: PYTHON_BIN=python3.11 $0"
  exit 1
fi

PY_VER="$("$PYTHON_BIN" -c 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
PY_MAJOR="${PY_VER%%.*}"
PY_MINOR="${PY_VER##*.}"
if [ "$PY_MAJOR" -ne 3 ] || [ "$PY_MINOR" -lt 10 ] || [ "$PY_MINOR" -gt 12 ]; then
  echo "[voicebox] unsupported Python version: $PY_VER"
  echo "[voicebox] requires Python 3.10 ~ 3.12"
  echo "Try: PYTHON_BIN=/usr/local/bin/python3.11 $0"
  exit 1
fi

mkdir -p "$ROOT_DIR/vendor"

if voicebox_repo_complete; then
  echo "[voicebox] repo exists: $VENDOR_DIR"
elif [ -d "$VENDOR_DIR" ] || [ -d "$VENDOR_DIR/.git" ]; then
  echo "[voicebox] repo incomplete, recloning: $VENDOR_DIR"
  refresh_voicebox_repo
else
  refresh_voicebox_repo
fi

if ! voicebox_repo_complete; then
  echo "[voicebox] required backend files missing after clone"
  echo "[voicebox] expected: $VOICEBOX_MAIN"
  echo "[voicebox] expected: $VOICEBOX_REQUIREMENTS"
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

VENV_PYTHON="$(resolve_venv_python || true)"
if [ -z "$VENV_PYTHON" ]; then
  echo "[voicebox] failed to locate venv python under: $VENV_DIR"
  exit 1
fi

"$VENV_PYTHON" -m pip install --upgrade pip wheel setuptools
"$VENV_PYTHON" -m pip install -r "$VOICEBOX_REQUIREMENTS"

# Apple Silicon users can optionally enable MLX backend.
# Disabled by default because upstream dependencies may conflict.
if [ "${ENABLE_MLX_BACKEND:-0}" = "1" ] && [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  "$VENV_PYTHON" -m pip install -r "$VOICEBOX_MLX_REQUIREMENTS"
else
  echo "[voicebox] skip optional MLX backend install (set ENABLE_MLX_BACKEND=1 to enable)."
fi

"$VENV_PYTHON" -m pip install "git+https://github.com/QwenLM/Qwen3-TTS.git" || \
  echo "[voicebox] optional Qwen3-TTS git install failed, continue with qwen-tts from requirements."

echo "[voicebox] setup complete."
echo "Run: $ROOT_DIR/scripts/start_voicebox_backend.sh"
