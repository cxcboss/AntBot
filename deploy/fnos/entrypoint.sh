#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${ANTBOT_DATA_ROOT:-/data}"
VIDEOS_ROOT="${ANTBOT_VIDEOS_ROOT:-/videos}"

mkdir -p "${DATA_ROOT}" "${VIDEOS_ROOT}"

export ANTBOT_HEADLESS="${ANTBOT_HEADLESS:-1}"
export ANTBOT_REMOTE_ENABLED="${ANTBOT_REMOTE_ENABLED:-1}"
export ANTBOT_DISABLE_CHROMIUM_SANDBOX="${ANTBOT_DISABLE_CHROMIUM_SANDBOX:-1}"

if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  if [ -d /ms-playwright ]; then
    export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
  elif [ -d /root/.cache/ms-playwright ]; then
    export PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
  fi
fi

export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${DATA_ROOT}/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${DATA_ROOT}/.cache}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-${DATA_ROOT}/.state}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${DATA_ROOT}/.local/share}"
mkdir -p "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}" "${XDG_STATE_HOME}" "${XDG_DATA_HOME}"

export ANTBOT_TEMP_DIR="${ANTBOT_TEMP_DIR:-${VIDEOS_ROOT}/temp}"
export ANTBOT_OUTPUT_BASE_DIR="${ANTBOT_OUTPUT_BASE_DIR:-${VIDEOS_ROOT}/output}"
mkdir -p "${ANTBOT_TEMP_DIR}" "${ANTBOT_OUTPUT_BASE_DIR}"

AUTODUB_ROOT="${ANTBOT_EDIT_PROJECT_PATH:-${DATA_ROOT}/engines/auto_dub_web}"
if [ ! -f "${AUTODUB_ROOT}/server.mjs" ]; then
  mkdir -p "${AUTODUB_ROOT}"
  cp -a /app/vendors/auto_dub_web/. "${AUTODUB_ROOT}/"
fi
mkdir -p "${AUTODUB_ROOT}/workspace" "${AUTODUB_ROOT}/outputs" "${AUTODUB_ROOT}/data"
export ANTBOT_EDIT_PROJECT_PATH="${AUTODUB_ROOT}"

if [ "${ANTBOT_PREPARE_VOICEBOX:-0}" = "1" ]; then
  if [ ! -x "${AUTODUB_ROOT}/.venv-voicebox/bin/python" ] && [ ! -x "${AUTODUB_ROOT}/.venv-voicebox/Scripts/python.exe" ]; then
    echo "[entrypoint] first-time voicebox dependency setup..."
    PYTHON_BIN="${ANTBOT_PYTHON_BIN:-python3}" "${AUTODUB_ROOT}/scripts/setup_voicebox_backend.sh"
  fi
fi

if [ -z "${ANTBOT_REMOTE_PASSWORD:-}" ]; then
  echo "[entrypoint] warning: ANTBOT_REMOTE_PASSWORD is empty, remote API login will fail until password is configured."
fi

DISPLAY_ID="${XVFB_DISPLAY:-:99}"
XVFB_RESOLUTION="${XVFB_RESOLUTION:-1920x1080x24}"
rm -f /tmp/.X99-lock
Xvfb "${DISPLAY_ID}" -screen 0 "${XVFB_RESOLUTION}" -nolisten tcp +extension RANDR &
XVFB_PID=$!
trap 'kill "${XVFB_PID}" >/dev/null 2>&1 || true' EXIT
export DISPLAY="${DISPLAY_ID}"

cd /app
ELECTRON_BIN="/app/node_modules/.bin/electron"
if [ -x "${ELECTRON_BIN}" ]; then
  if [ "${ANTBOT_DISABLE_CHROMIUM_SANDBOX:-0}" = "1" ]; then
    exec "${ELECTRON_BIN}" . --no-sandbox --disable-setuid-sandbox
  fi
  exec "${ELECTRON_BIN}" .
fi

exec npm run dev
