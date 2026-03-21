# AntBot

AntBot 是一个 Electron 桌面工作台，用于在内置 Chromium 环境中串行执行以下流程：

1. 启动检查：视频号 / 抖音登录状态（任一通过即可启动），Gemini 状态仅提示不阻塞，语音克隆状态。
2. 输入多条任务：发布时间、任务名、原创（可选）、视频链接、时间段（可选）。
3. 视频下载（支持命令模板；默认自动探测 `yt-dlp`，缺失时会尝试 `python -m yt_dlp` 并自动安装）。
4. Gemini 字幕生成（默认 Playwright 自动化；支持自定义命令，内置“严格 SRT 校验 + 非法结果重试”）。
5. 视频剪辑（默认接入 `auto_dub_web`，输入为“下载视频 + 第4步 SRT 字幕”；也支持自定义命令）。
6. 视频发布（支持自定义命令；默认内置浏览器自动化发布到视频号/抖音，自动填写默认话题，视频号可按任务名识别活动）。
7. 发布记录落盘。
8. 按任务顺序循环执行，每条完整走完 3-6 后再执行下一条。

## 本地运行

```bash
npm install
npm run dev
```

首次安装会下载 Playwright Chromium（`postinstall`）。

## 输入格式

一行一个任务，字段使用中文逗号或英文逗号分隔：

- `发布时间, 任务名, 原创(可选), 视频链接, 时间段(可选)`
- `任务名, 视频链接`
- `发布时间, 任务名, 视频链接, 时间段`

平台规则（按整行关键词）：
- 含 `微信` 或 `视频号`：发布到视频号
- 含 `抖音`：发布到抖音
- 同时含两者：双平台都发布
- 都不含：默认发布到视频号

示例：

```text
3月6日7时36分，小兵冲冲冲，微信，https://youtu.be/Q9KWcWKo2T8?si=dy-UUoSiR6bPtlLb，0:49-22:12
原创，https://youtu.be/xxxx
```

## 文件命名规则

- 临时视频：`YYYYMMDD序号-任务名.mp4`
- 临时原创：`YYYYMMDD序号-原创.mp4`
- 输出目录：`桌面/视频/3月5日26年/`
- 输出文件：`3月5日26年-任务名.mp4` 或 `3月5日26年-原创.mp4`

## 命令模板（设置页可配）

### 下载命令

可用变量：`{url}` `{output}` `{timeRange}` `{taskName}` `{original}`

示例（接入你的 YouTube 项目）：

```bash
python main.py --url "{url}" --output "{output}" --range "{timeRange}"
```

### Gemini 命令（可选）

不填则走内置浏览器自动化。
变量：`{url}` `{timeRange}` `{output}` `{prompt}`

### 剪辑命令（可选）

变量：`{taskName}` `{original}` `{inputVideo}` `{subtitleFile}` `{outputVideo}` `{voiceId}` `{voiceSpeed}` `{subtitleColor}` `{subtitleStroke}`

不配置时会自动尝试使用以下目录的 `auto_dub_web`：
- 设置里的“剪辑项目目录”
- 或当前项目下的 `vendors/auto_dub_web`

并调用其 `/api/process`，参数默认：
- `tts_mode=voice_clone`（有 `voiceId`）否则 `system`
- `dub_speed=1.1`
- 保留原声 + 混音
- 字幕位置底部

### 语音克隆（Voicebox 方式）

- 在主界面点击“克隆”，打开专用语音克隆面板。
- 填写样本音频（wav/mp3/m4a 等）和参考文本（必须与音频内容一致）。
- 面板内会显示专用进度条与日志，阶段包含：环境检查、依赖安装、后端启动、上传样本、创建档案。
- 首次运行会自动尝试执行 `scripts/setup_voicebox_backend.sh` 和 `scripts/start_voicebox_backend.sh`，并自动探测 Python。
- 成功后自动写入 `voiceId`，第 5 步剪辑会直接复用该音色。

### 发布命令

变量：`{video}` `{scheduleAt}` `{taskName}` `{platform}` `{original}`

注意：如果你填写了“发布命令”，将优先执行该命令，不会走下面的内置发布自动化。

默认内置发布逻辑：
- 走内置浏览器（Playwright 持久化 profile）直接操作发布页。
- 自动填写描述：`任务名 + 默认话题`（`#动画 #奇葩游戏 #游戏视频 #小游戏 #休闲游戏`）。
- 视频号活动：任务名含 `小游戏-活动名` 时自动尝试选择对应活动。
- 指定发布时间时会强校验定时设置；若定时控件未识别则直接报错并停止该条发布，避免误发成立即发布。
- 未指定发布时间时立即发布。

## 打包

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

打包结果输出到 `release/`。
- mac 打包会自动使用项目根目录的 `icons.png` 生成 `assets/icon.icns` 作为应用图标。

## 飞牛 NAS（fnOS）部署

针对 NAS 场景，项目新增了 Docker/Compose 部署包（后台运行 + 远程控制）：

- 目录：`deploy/fnos/`
- Compose 文件：`deploy/fnos/docker-compose.yml`
- 镜像构建与导出脚本：`scripts/package-fnos-image.sh`

快速开始：

```bash
# 国内网络优先（推荐，一键带国内镜像 + 失败自动回退）
npm run build:fnos:image:cn

# 本机构建并导出镜像 tar（默认 linux/amd64）
npm run build:fnos:image

# ARM 飞牛（例如 RK/ARM 平台）
PLATFORM=linux/arm64 npm run build:fnos:image

# 如果 Docker Hub 拉取失败，可切换基础镜像到可访问的镜像源
BASE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim npm run build:fnos:image

# 如果 apt 源不稳定（debian-security EOF/500），同时切换 apt 镜像
BASE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim \
APT_DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian \
APT_SECURITY_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian-security \
PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright \
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn \
PLATFORM=linux/amd64 npm run build:fnos:image
```

导出文件位于：`release/antbot-fnos-latest-linux_amd64.tar`（文件名按参数可能不同）。

在 fnOS 中：
1. 导入该镜像（或直接在 Compose 中构建）。
2. 修改 `ANTBOT_REMOTE_PASSWORD` 为强密码。
3. 启动后访问 `http://NAS_IP:17888/remote/`。

更多说明见：`deploy/fnos/README.md`。

## 说明

- 点击“设置 -> 登录XXX”会打开 Playwright 持久化浏览器窗口，登录完成后点击“确定”标记；同一 profile 会被启动检查和自动化流程复用。
- 启动要求：抖音 / 视频号任一已登录即可；Gemini 登录检查默认跳过（不阻塞任务启动）。
- 语音克隆音色会持久保存，除非你在设置中清空 `voiceId` 或删除模型文件。
- 打包时会携带 `vendors/auto_dub_web`，首次运行会自动复制到用户可写目录后再调用，避免安装目录写权限问题。
