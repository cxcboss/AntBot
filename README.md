# AntBot / 搬运蚁

AntBot 是一个 Electron 桌面工作台，用来把视频下载、字幕生成、二创剪辑、定时发布整合到一条可批量执行的流水线里。

它在内置 Chromium 环境中复用登录态，按任务顺序串行执行以下步骤：

1. 启动检查
2. 下载视频
3. 生成字幕
4. 剪辑与配音
5. 发布到视频号 / 抖音
6. 写入发布记录和运行日志

除了桌面端，它还提供远程控制页面、fnOS/NAS Docker 部署包，以及用于 NAS 中转访问的 relay app。

## 核心能力

- 内置 Playwright + Chromium，复用视频号、抖音、Gemini 登录态
- 多任务批量输入，按顺序串行执行完整流程
- 视频下载支持命令模板；默认自动探测 `yt-dlp`，缺失时自动回退 `python -m yt_dlp`
- Gemini 字幕生成支持默认浏览器自动化，也支持自定义命令接入
- SRT 结果会做严格校验，非法字幕会自动重试
- 剪辑阶段默认接入 `vendors/auto_dub_web`，也支持外部命令模板
- 支持 Voicebox 语音克隆，生成的 `voiceId` 可直接复用到剪辑流程
- 支持自动发布开关、失败任务自动重试、发布记录落盘
- 支持多用户隔离，登录态、设置、历史记录按用户分开保存
- 远程控制页面支持查看状态、提交任务、排队、查看日志
- 提供 fnOS Docker 部署方案和 relay app，适合 NAS 场景

## 适用场景

- 在一台桌面机上批量处理短视频任务
- 把下载、字幕、配音、发布流程固定成标准流水线
- 在局域网或 NAS 环境里远程控制桌面端执行任务
- 给不同账号或不同操作者做多用户隔离

## 工作流

1. 在设置页登录视频号、抖音、Gemini。
2. 输入多条任务。
3. 启动检查会确认视频号 / 抖音至少一个已登录；Gemini 仅提示不阻塞启动。
4. 每条任务依次执行下载、字幕、剪辑、发布。
5. 若启用失败重试，全部任务跑完后会再重试失败项。
6. 输出文件、运行日志、发布记录会保存到本地数据目录。

## 快速开始

### 环境要求

- Node.js 20+
- macOS / Windows / Linux
- 首次安装需要联网下载 Playwright Chromium

### 本地运行

```bash
npm install
npm run dev
```

`postinstall` 会自动执行 `playwright install chromium`。

### 首次使用建议

1. 打开“设置”页面。
2. 分别完成视频号、抖音、Gemini 登录。
3. 如需语音克隆，先在“克隆”面板生成 `voiceId`。
4. 根据需要配置下载、字幕、剪辑、发布命令模板。
5. 回到主界面粘贴任务文本并启动。

## 任务输入格式

一行一个任务，字段可以使用中文逗号或英文逗号分隔。

支持格式：

- `发布时间, 任务名, 原创(可选), 视频链接, 时间段(可选)`
- `任务名, 视频链接`
- `发布时间, 任务名, 视频链接, 时间段`

平台判定规则：

- 包含 `微信` 或 `视频号`，发布到视频号
- 包含 `抖音`，发布到抖音
- 同时包含两者，双平台发布
- 都不包含时，默认发布到视频号

示例：

```text
3月6日7时36分，小兵冲冲冲，微信，https://youtu.be/Q9KWcWKo2T8?si=dy-UUoSiR6bPtlLb，0:49-22:12
原创，https://youtu.be/xxxx
```

## 输出规则

- 临时视频：`YYYYMMDD序号-任务名.mp4`
- 临时原创：`YYYYMMDD序号-原创.mp4`
- 输出目录：`桌面/视频/3月5日26年/`
- 输出文件：`3月5日26年-任务名.mp4` 或 `3月5日26年-原创.mp4`

## 命令模板

如果你已经有自己的脚本链路，可以直接在设置页配置命令模板，把 AntBot 当作任务编排器来用。

### 下载命令

变量：`{url}` `{output}` `{timeRange}` `{taskName}` `{original}`

示例：

```bash
python main.py --url "{url}" --output "{output}" --range "{timeRange}"
```

### Gemini 命令

变量：`{url}` `{timeRange}` `{output}` `{prompt}`

不填时默认走内置浏览器自动化。

### 剪辑命令

变量：`{taskName}` `{original}` `{inputVideo}` `{subtitleFile}` `{outputVideo}` `{voiceId}` `{voiceSpeed}` `{subtitleColor}` `{subtitleStroke}`

不配置时会优先尝试：

- 设置中的“剪辑项目目录”
- 当前仓库里的 `vendors/auto_dub_web`

默认通过其 `/api/process` 接口执行处理。

### 发布命令

变量：`{video}` `{scheduleAt}` `{taskName}` `{platform}` `{original}`

如果填写了“发布命令”，会优先执行该命令，不再走内置发布自动化。

## 默认内置行为

### 字幕生成

- 默认使用 Gemini 浏览器自动化
- 支持自定义 Gemini 页面地址
- 对输出结果做 SRT 严格校验
- 校验失败会自动重试

### 剪辑与配音

- 默认接入 `auto_dub_web`
- 支持字幕开关与旁白开关
- 旁白关闭时会强制关闭字幕
- 字幕默认无黑底，按 SRT 时间轴对齐语音

### 自动发布

- 默认使用 Playwright 持久化 profile 直接操作发布页
- 自动填写描述：`任务名 + 默认话题`
- 视频号支持根据任务名自动识别活动
- 指定发布时间时会强校验定时设置，避免误发成立即发布

## 语音克隆

- 主界面点击“克隆”打开语音克隆面板
- 支持上传样本音频和参考文本
- 首次运行会尝试安装 Voicebox 后端依赖并启动服务
- 成功后会写入 `voiceId`，后续剪辑阶段直接复用
- 语音克隆结果可跨用户共享

## 远程控制与 NAS 部署

### 桌面端远程控制

项目内置远程页面，适合在手机或局域网设备上查看状态、提交任务和查看日志。

- 前端目录：`src/remote/`
- 远程能力：状态查看、任务提交、排队展示、日志查看、用户切换

### fnOS Docker 部署

适合让 AntBot 在 NAS 里后台运行，并通过浏览器访问远程页面。

- 部署目录：[`deploy/fnos/`](deploy/fnos/)
- 详细说明：[`deploy/fnos/README.md`](deploy/fnos/README.md)
- 关键命令：

```bash
npm run build:fnos:image:cn
npm run build:fnos:image
PLATFORM=linux/arm64 npm run build:fnos:image
```

启动后默认访问：`http://NAS_IP:17888/remote/`

### fnOS Relay App

这个 app 适合放在 NAS 上做中转，不直接执行桌面自动化，而是把远程页面和 `/api/*` 请求转发到局域网里的桌面端。

- 目录：[`deploy/fnos-relay-app/`](deploy/fnos-relay-app/)
- 详细说明：[`deploy/fnos-relay-app/README.md`](deploy/fnos-relay-app/README.md)
- 本地打包：

```bash
npm run build:fnos:relay
```

## 构建与打包

```bash
npm run build:mac
npm run build:win
npm run build:win:portable
npm run build:win:arm64
npm run build:linux
```

产物默认输出到 `release/`。

说明：

- mac 打包会使用根目录 `icons.png` 生成 `assets/icon.icns`
- 打包时会携带 `vendors/auto_dub_web`
- Windows 构建可使用单独的 portable 产物

## 仓库结构

```text
src/main/                 Electron 主进程、任务编排、自动化服务
src/renderer/             桌面端 UI
src/remote/               远程控制页面
vendors/auto_dub_web/     默认剪辑 / 配音能力
deploy/fnos/              fnOS Docker 部署方案
deploy/fnos-relay-app/    NAS 中转 app
clients/antbot_flutter/   Flutter 客户端
scripts/                  打包、环境准备、镜像导出脚本
```

## 数据与状态

- 用户数据会持久化到稳定的 `appData/antbot` 目录
- 登录态、任务历史、发布记录、远程设置默认按用户隔离
- Gemini 环境和语音克隆结果支持共享模式
- 运行日志会保存到用户数据目录下的 `logs/tasks/`

## 补充说明

- 点击“设置 -> 登录XXX”会打开 Playwright 持久化浏览器窗口，登录完成后由同一 profile 复用
- 启动要求是“视频号 / 抖音任一已登录”，Gemini 检查默认不阻塞任务启动
- 关闭“自动发布”后，流程只会完成下载、字幕、剪辑，不会执行发布
- 若删除 `voiceId` 或模型文件，语音克隆能力需要重新准备

## 相关文档

- [`AI_IMPLEMENTATION.md`](AI_IMPLEMENTATION.md)
- [`DEV_LOG.md`](DEV_LOG.md)
- [`deploy/fnos/README.md`](deploy/fnos/README.md)
- [`deploy/fnos-relay-app/README.md`](deploy/fnos-relay-app/README.md)
