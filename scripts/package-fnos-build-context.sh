#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/release}"
STAGING_DIR="${OUTPUT_DIR}/.fnos-build-staging"
SOURCE_DIR="${STAGING_DIR}/antbot-src"
ARCHIVE_NAME="${ARCHIVE_NAME:-antbot-fnos-build-context-$(date +%Y%m%d).tar.gz}"
ARCHIVE_FILE="${OUTPUT_DIR}/${ARCHIVE_NAME}"
COMPOSE_SOURCE="${ROOT_DIR}/deploy/fnos/docker-compose.build.yml"
COMPOSE_TARGET="${OUTPUT_DIR}/docker-compose.fnos-build.yml"

mkdir -p "${OUTPUT_DIR}"
rm -rf "${STAGING_DIR}"
mkdir -p "${SOURCE_DIR}"

COPYFILE_DISABLE=1 rsync -a \
  --delete \
  --exclude-from="${ROOT_DIR}/.dockerignore" \
  "${ROOT_DIR}/" "${SOURCE_DIR}/"

cp "${COMPOSE_SOURCE}" "${COMPOSE_TARGET}"

COPYFILE_DISABLE=1 tar -czf "${ARCHIVE_FILE}" -C "${STAGING_DIR}" antbot-src

rm -rf "${STAGING_DIR}"

echo "[package-fnos-build-context] source archive: ${ARCHIVE_FILE}"
echo "[package-fnos-build-context] compose file: ${COMPOSE_TARGET}"
