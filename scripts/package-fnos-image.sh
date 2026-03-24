#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

IMAGE_NAME="${IMAGE_NAME:-antbot}"
IMAGE_TAG="${IMAGE_TAG:-fnos-latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
BASE_IMAGE="${BASE_IMAGE:-node:22-bookworm-slim}"
APT_DEBIAN_MIRROR="${APT_DEBIAN_MIRROR:-https://deb.debian.org/debian}"
APT_SECURITY_MIRROR="${APT_SECURITY_MIRROR:-https://deb.debian.org/debian-security}"
APT_ALLOW_INSECURE="${APT_ALLOW_INSECURE:-0}"
PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-}"
PIP_INDEX_URL="${PIP_INDEX_URL:-}"
PIP_TRUSTED_HOST="${PIP_TRUSTED_HOST:-}"
NPM_REGISTRY="${NPM_REGISTRY:-}"
FORCE_NO_PROXY="${FORCE_NO_PROXY:-1}"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/release}"
OUTPUT_FILE="${OUTPUT_DIR}/${IMAGE_NAME//\//_}-${IMAGE_TAG}-${PLATFORM//\//_}.tar"

mkdir -p "${OUTPUT_DIR}"

proxy_build_args=()
if [ "${FORCE_NO_PROXY}" = "1" ]; then
  proxy_build_args=(
    --build-arg "HTTP_PROXY="
    --build-arg "HTTPS_PROXY="
    --build-arg "ALL_PROXY="
    --build-arg "NO_PROXY="
    --build-arg "http_proxy="
    --build-arg "https_proxy="
    --build-arg "all_proxy="
    --build-arg "no_proxy="
  )
fi

if docker buildx version >/dev/null 2>&1; then
  echo "[package-fnos] base image: ${BASE_IMAGE}"
  echo "[package-fnos] apt debian mirror: ${APT_DEBIAN_MIRROR}"
  echo "[package-fnos] apt security mirror: ${APT_SECURITY_MIRROR}"
  echo "[package-fnos] apt allow insecure: ${APT_ALLOW_INSECURE}"
  echo "[package-fnos] force no proxy: ${FORCE_NO_PROXY}"
  if [ -n "${PLAYWRIGHT_DOWNLOAD_HOST}" ]; then
    echo "[package-fnos] playwright download host: ${PLAYWRIGHT_DOWNLOAD_HOST}"
  fi
  if [ -n "${ELECTRON_MIRROR}" ]; then
    echo "[package-fnos] electron mirror: ${ELECTRON_MIRROR}"
  fi
  if [ -n "${PIP_INDEX_URL}" ]; then
    echo "[package-fnos] pip index-url: ${PIP_INDEX_URL}"
  fi
  if [ -n "${PIP_TRUSTED_HOST}" ]; then
    echo "[package-fnos] pip trusted-host: ${PIP_TRUSTED_HOST}"
  fi
  if [ -n "${NPM_REGISTRY}" ]; then
    echo "[package-fnos] npm registry: ${NPM_REGISTRY}"
  fi
  docker buildx build \
    --platform "${PLATFORM}" \
    --load \
    "${proxy_build_args[@]}" \
    --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
    --build-arg "APT_DEBIAN_MIRROR=${APT_DEBIAN_MIRROR}" \
    --build-arg "APT_SECURITY_MIRROR=${APT_SECURITY_MIRROR}" \
    --build-arg "APT_ALLOW_INSECURE=${APT_ALLOW_INSECURE}" \
    --build-arg "PLAYWRIGHT_DOWNLOAD_HOST=${PLAYWRIGHT_DOWNLOAD_HOST}" \
    --build-arg "ELECTRON_MIRROR=${ELECTRON_MIRROR}" \
    --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL}" \
    --build-arg "PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}" \
    --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
    -f deploy/fnos/Dockerfile \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    .
else
  echo "[package-fnos] buildx not found, fallback to local docker build."
  echo "[package-fnos] base image: ${BASE_IMAGE}"
  echo "[package-fnos] apt debian mirror: ${APT_DEBIAN_MIRROR}"
  echo "[package-fnos] apt security mirror: ${APT_SECURITY_MIRROR}"
  echo "[package-fnos] apt allow insecure: ${APT_ALLOW_INSECURE}"
  echo "[package-fnos] force no proxy: ${FORCE_NO_PROXY}"
  if [ -n "${PLAYWRIGHT_DOWNLOAD_HOST}" ]; then
    echo "[package-fnos] playwright download host: ${PLAYWRIGHT_DOWNLOAD_HOST}"
  fi
  if [ -n "${ELECTRON_MIRROR}" ]; then
    echo "[package-fnos] electron mirror: ${ELECTRON_MIRROR}"
  fi
  if [ -n "${PIP_INDEX_URL}" ]; then
    echo "[package-fnos] pip index-url: ${PIP_INDEX_URL}"
  fi
  if [ -n "${PIP_TRUSTED_HOST}" ]; then
    echo "[package-fnos] pip trusted-host: ${PIP_TRUSTED_HOST}"
  fi
  if [ -n "${NPM_REGISTRY}" ]; then
    echo "[package-fnos] npm registry: ${NPM_REGISTRY}"
  fi
  docker build \
    "${proxy_build_args[@]}" \
    --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
    --build-arg "APT_DEBIAN_MIRROR=${APT_DEBIAN_MIRROR}" \
    --build-arg "APT_SECURITY_MIRROR=${APT_SECURITY_MIRROR}" \
    --build-arg "APT_ALLOW_INSECURE=${APT_ALLOW_INSECURE}" \
    --build-arg "PLAYWRIGHT_DOWNLOAD_HOST=${PLAYWRIGHT_DOWNLOAD_HOST}" \
    --build-arg "ELECTRON_MIRROR=${ELECTRON_MIRROR}" \
    --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL}" \
    --build-arg "PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}" \
    --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
    -f deploy/fnos/Dockerfile \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    .
fi

docker save -o "${OUTPUT_FILE}" "${IMAGE_NAME}:${IMAGE_TAG}"
echo "[package-fnos] image exported: ${OUTPUT_FILE}"
