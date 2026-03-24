ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

ARG APT_DEBIAN_MIRROR=https://deb.debian.org/debian
ARG APT_SECURITY_MIRROR=https://deb.debian.org/debian-security
ARG APT_ALLOW_INSECURE=0

RUN set -eux; \
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
    if [ -f "${file}" ]; then \
      sed -i "s|http://deb.debian.org/debian|${APT_DEBIAN_MIRROR}|g" "${file}"; \
      sed -i "s|http://deb.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" "${file}"; \
      sed -i "s|http://security.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" "${file}"; \
    fi; \
  done; \
  install_pkgs='ca-certificates curl ffmpeg git libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcb-dri3-0 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 python3 python3-pip python3-setuptools python3-venv python3-wheel tini unzip xauth xvfb'; \
  apt_update_opts='-o Acquire::Retries=20 -o Acquire::http::Proxy=false -o Acquire::https::Proxy=false'; \
  apt_install_opts='-y --no-install-recommends --fix-missing'; \
  apt_fix_opts='-y --fix-broken'; \
  if [ "${APT_ALLOW_INSECURE}" = "1" ]; then \
    apt_update_opts="${apt_update_opts} -o Acquire::AllowInsecureRepositories=true -o Acquire::AllowDowngradeToInsecureRepositories=true"; \
    apt_install_opts="${apt_install_opts} --allow-unauthenticated"; \
    apt_fix_opts="${apt_fix_opts} --allow-unauthenticated"; \
  fi; \
  attempt=1; \
  while [ "${attempt}" -le 8 ]; do \
    if apt-get update ${apt_update_opts} \
      && apt-get install ${apt_install_opts} ${install_pkgs}; then \
      break; \
    fi; \
    apt-get -f install ${apt_fix_opts} || true; \
    dpkg --configure -a || true; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/* /var/cache/apt/archives/*.deb; \
    if [ "${attempt}" -eq 8 ]; then \
      echo "apt install failed after ${attempt} attempts"; \
      exit 1; \
    fi; \
    echo "apt install failed on attempt ${attempt}, retrying..."; \
    attempt=$((attempt + 1)); \
    sleep 3; \
  done; \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/* /var/cache/apt/archives/*.deb

COPY package.json package-lock.json ./

# Download browser in a dedicated step so image build logs clearly show failures.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ARG NPM_REGISTRY=
ARG ELECTRON_MIRROR=
RUN set -eux; \
  if [ -n "${NPM_REGISTRY}" ]; then \
    npm config set registry "${NPM_REGISTRY}"; \
  fi; \
  if [ -n "${ELECTRON_MIRROR}" ]; then \
    export ELECTRON_MIRROR="${ELECTRON_MIRROR}"; \
    export npm_config_electron_mirror="${ELECTRON_MIRROR}"; \
    export electron_config_cache=/root/.cache/electron; \
  fi; \
  npm ci

COPY . .

ARG PLAYWRIGHT_DOWNLOAD_HOST=
ARG PIP_INDEX_URL=
ARG PIP_TRUSTED_HOST=
RUN set -eux; \
  if [ -n "${PLAYWRIGHT_DOWNLOAD_HOST}" ]; then \
    export PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}"; \
  fi; \
  if [ -n "${PIP_INDEX_URL}" ]; then \
    python3 -m pip config set global.index-url "${PIP_INDEX_URL}"; \
  fi; \
  if [ -n "${PIP_TRUSTED_HOST}" ]; then \
    python3 -m pip config set global.trusted-host "${PIP_TRUSTED_HOST}"; \
  fi; \
  npx playwright install chromium \
  && npm run prepare:voicebox \
  && python3 -m pip install --no-cache-dir --break-system-packages "yt-dlp>=2025.01.15"

ARG PREPARE_VOICEBOX=0
RUN if [ "${PREPARE_VOICEBOX}" = "1" ]; then \
      PYTHON_BIN=python3 ./vendors/auto_dub_web/scripts/setup_voicebox_backend.sh; \
    else \
      echo "[build] skip pre-installing voicebox dependencies"; \
    fi

RUN chmod +x /app/deploy/fnos/entrypoint.sh

ENV NODE_ENV=production \
  TZ=Asia/Shanghai \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  ANTBOT_HEADLESS=1 \
  ANTBOT_REMOTE_ENABLED=1 \
  ANTBOT_REMOTE_PORT=17888 \
  ANTBOT_DISABLE_CHROMIUM_SANDBOX=1 \
  ANTBOT_DATA_ROOT=/data \
  ANTBOT_PREPARE_VOICEBOX=0

VOLUME ["/data", "/videos"]

EXPOSE 17888

ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/fnos/entrypoint.sh"]
