#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PLATFORM="${PLATFORM:-linux/amd64}"
IMAGE_NAME="${IMAGE_NAME:-antbot}"
IMAGE_TAG="${IMAGE_TAG:-fnos-latest}"

BASE_IMAGE="${BASE_IMAGE:-swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim}"
APT_DEBIAN_MIRROR="${APT_DEBIAN_MIRROR:-http://mirrors.aliyun.com/debian}"
APT_SECURITY_MIRROR="${APT_SECURITY_MIRROR:-http://mirrors.aliyun.com/debian-security}"
PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-https://npmmirror.com/mirrors/playwright}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
PIP_TRUSTED_HOST="${PIP_TRUSTED_HOST:-pypi.tuna.tsinghua.edu.cn}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

run_build() {
  local insecure="$1"
  echo "[package-fnos-cn] start build (APT_ALLOW_INSECURE=${insecure})"
  BASE_IMAGE="${BASE_IMAGE}" \
  APT_DEBIAN_MIRROR="${APT_DEBIAN_MIRROR}" \
  APT_SECURITY_MIRROR="${APT_SECURITY_MIRROR}" \
  APT_ALLOW_INSECURE="${insecure}" \
  PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}" \
  ELECTRON_MIRROR="${ELECTRON_MIRROR}" \
  PIP_INDEX_URL="${PIP_INDEX_URL}" \
  PIP_TRUSTED_HOST="${PIP_TRUSTED_HOST}" \
  NPM_REGISTRY="${NPM_REGISTRY}" \
  PLATFORM="${PLATFORM}" \
  IMAGE_NAME="${IMAGE_NAME}" \
  IMAGE_TAG="${IMAGE_TAG}" \
  npm run build:fnos:image
}

if [ -n "${APT_ALLOW_INSECURE:-}" ]; then
  run_build "${APT_ALLOW_INSECURE}"
  exit 0
fi

if run_build 0; then
  exit 0
fi

echo "[package-fnos-cn] first attempt failed, retry with APT_ALLOW_INSECURE=1"
run_build 1
