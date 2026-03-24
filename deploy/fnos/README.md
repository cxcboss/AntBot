# AntBot 飞牛 NAS 部署包

本目录用于在飞牛 fnOS 的 Docker / Compose 中部署 AntBot（后台无界面运行，使用远程页面控制）。

## 1. 直接用 Compose（推荐）

1. 先在飞牛 Docker 中导入镜像 `antbot:fnos-latest`（见下方第 2 节）。
2. 把 `deploy/fnos/docker-compose.yml` 放到飞牛的某个项目目录。
3. 在飞牛 Docker 应用的 `Compose` 中创建项目并启动。
4. 浏览器访问：`http://NAS_IP:17888/remote/`

## 2. 构建镜像并导入飞牛

可在任意支持 Docker 的机器执行：

```bash
# 国内网络建议直接用一键脚本（自动套用国内镜像）
npm run build:fnos:image:cn

docker build -f deploy/fnos/Dockerfile -t antbot:fnos-latest .
docker save -o antbot-fnos-latest.tar antbot:fnos-latest

# ARM 平台可用 buildx
docker buildx build --platform linux/arm64 --load -f deploy/fnos/Dockerfile -t antbot:fnos-latest .

# Docker Hub 不可用时可切换基础镜像源
docker build --build-arg BASE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim -f deploy/fnos/Dockerfile -t antbot:fnos-latest .

# Debian 源不稳定时可切换 apt 镜像源
docker build \
  --build-arg BASE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim \
  --build-arg APT_DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian \
  --build-arg APT_SECURITY_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian-security \
  --build-arg PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright \
  --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  --build-arg PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn \
  -f deploy/fnos/Dockerfile -t antbot:fnos-latest .
```

然后在飞牛 Docker 中导入 `antbot-fnos-latest.tar`，再用 Compose 或容器方式运行。

## 3. 数据卷说明

- `./data:/data`：应用状态、登录态、远程设置、运行缓存
- `./videos:/videos`：视频临时目录与输出目录

## 4. 关键环境变量

- `ANTBOT_REMOTE_PORT`：远程服务端口（默认 `17888`）
- `ANTBOT_PREPARE_VOICEBOX`：`1` 时容器首次启动会自动安装 voicebox 依赖（较慢）
- `ANTBOT_DATA_ROOT`：应用数据根目录（默认 `/data`）
- `ANTBOT_VIDEOS_ROOT`：视频工作目录根（默认 `/videos`）

## 5. 说明

- 容器内使用 `Xvfb` 提供虚拟显示，支持 Playwright 自动化能力。
- 已内置 Chromium、ffmpeg、Python3、yt-dlp 运行依赖。
