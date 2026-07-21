# AntBot 开发记录

> 最后更新：2026-07-21 | 版本：0.3.6 | 分支：codex/fix-repeated-video-voice

## 项目概况

AntBot（搬运蚁）是 Electron 桌面应用，核心做视频自动化流水线：下载 → 字幕生成 → 剪辑配音 → 发布。

## 2026-07-21 剪辑缓存清理与语音生成修复

### 背景

用户反馈剪辑视频配音异常，多个剪辑视频会重复同一句参考语音。随后检查 `~/AntBot` 数据目录，发现旧剪辑流程通过 Voicebox `/generate` 生成了大量持久化历史 WAV，失败/取消/中断后也没有统一清理抽帧、字幕、TTS、合成中间文件。

### 根因

- 剪辑 TTS 使用 Voicebox `/generate` + `/audio/{id}`，会在 `~/AntBot/voicebox-data/generations` 写入历史记录和 WAV。
- 智能剪辑准备阶段使用系统临时目录 `antbot-smart-edit-*`，只有部分取消路径会清理。
- `auto_dub_web/workspace` 和 `auto_dub_web/outputs` 缺少成功/失败/启动时的完整清理。
- App 启动恢复只重置任务状态，没有按任务归属回收残留缓存。

### 代码变更

- 新增 `src/main/services/clipArtifacts.js`，统一管理 `~/AntBot/clip-cache/<task-id>`，只删除应用明确拥有的剪辑缓存。
- `smartEditor.js` 改为按任务写入 `clip-cache`；成功生成 SRT 后立即删除抽帧图，准备阶段异常会清理任务目录。
- `editScheduler.js` 在失败、取消、移除、退出和启动恢复时清理相关缓存；中断的 `preparing/composing` 任务重置为 `pending`。
- `vendors/auto_dub_web/server.mjs` 启动时清理旧 `workspace/outputs`；单个 job 在 `finally` 删除 workspace。
- `autoDubClient.js` 复制最终输出后删除 auto_dub 的临时输出副本，最终成片保留在用户输出目录。
- `voicebox-generation.mjs` 和 `server.mjs` 改用 `/generate/stream`，保留 `x_vector_only_mode: true`，避免继续产生 Voicebox history WAV。
- 合并 Claude 工作树中的最新智能剪辑 UI/调度/API 实现，同时保留当前分支的参考音频泄漏修复。

### 数据清理

清理范围严格限制为剪辑过程垃圾：

- 通过 Voicebox history API 删除 261 条剪辑生成记录。
- `~/AntBot/voicebox-data/generations`：261 个 WAV，约 145 MB → 0 个 WAV，0B。
- 删除 1 个 0 字节临时 store 文件：`antbot-store.json.63744.1784531909843.tmp`。
- 未删除：`voicebox-data/models`、`voicebox-data/profiles`、`voicebox-env`、`models`、`browser-profiles`、App 设置、音色档案、最终输出视频。

### 验证

- `node --test src/main/services/tests/clipArtifacts.test.js vendors/auto_dub_web/tests/clip-workspace.test.mjs vendors/auto_dub_web/tests/voicebox-generation.test.mjs`
- `PYTHONPATH=vendors/auto_dub_web/vendor/voicebox /Users/chenxincheng/AntBot/voicebox-env/.venv-voicebox/bin/python -m unittest vendors.auto_dub_web.vendor.voicebox.backend.tests.test_reference_audio_leak`
- `node --check` 覆盖 `ipc.js`、`preload.js`、`renderer/app.js`、`editScheduler.js`、`smartEditor.js`、`autoDubClient.js`、`apiServer.js`、`server.mjs`
- `npm run build:mac`
- App 产物：`/Users/chenxincheng/Desktop/my/Develop/Claude/AntBot/搬运蚁.app`
- DMG 产物：`/Users/chenxincheng/Desktop/my/Develop/Claude/AntBot/release/搬运蚁-0.3.6-mac-arm64.dmg`

## 当前架构

```
src/main/
  index.js              Electron 主进程入口
  ipc.js                所有 IPC handler（核心业务逻辑集中于此）
  preload.js            contextBridge 暴露给渲染进程的 API
  taskRunner.js         任务队列与串行执行
  services/
    autoDubClient.js    auto_dub_web 服务管理、语音克隆后端
    commandRunner.js    通用命令执行器
    config.js           配置管理
    dependencyInstaller.js  逐包 pip 安装、进度解析、取消（新增）
    dependencyManager.js    系统依赖检测（node/yt-dlp/ffmpeg 等）
    downloader.js       视频下载
    editor.js           剪辑调用
    fileUtil.js         文件工具
    gemini.js           Gemini 字幕生成
    parser.js           任务文本解析
    playwrightUtil.js   Playwright 浏览器管理
    publisher.js        视频号/抖音发布
    startupCheck.js     启动检查
    store.js            数据持久化
    systemControl.js    系统控制
    voiceClone.js       语音克隆流程入口
    runtimeEnv.js       运行时环境变量
    appInfo.js          应用信息

src/renderer/
  index.html            主页面
  app.js                渲染进程逻辑
  style.css             样式
  icons.js              SVG 图标定义
  anime.min.js          动画库

vendors/auto_dub_web/   剪辑配音引擎（内置）

scripts/                构建脚本
deploy/                 （已移除 fnOS 部署，保留目录结构）
```

## v0.3.6 主要变更

### 移除的内容
- Flutter 客户端 (`clients/antbot_flutter/`)
- fnOS Docker 部署方案 (`deploy/fnos/`)
- fnOS Relay App (`deploy/fnos-relay-app/`)
- 旧版远程控制页面 (`src/remote/`)
- Figma 资源文件 (`src/renderer/assets/figma/`)
- 旧版根目录文件 (`app.js`, `index.html`, `style.css`, `remoteControl.js`)
- voicebox 不必要的文件（tests、mlx backend 等）

### 新增
- `src/renderer/icons.js` — 集中管理 SVG 图标
- `src/renderer/anime.min.js` — 动画库
- `src/main/services/dependencyInstaller.js` — 逐包依赖安装模块
- Voicebox 环境管理面板（检测、安装、重置）
- 模型管理（list/download/delete）
- 字体管理、风格学习
- App logger（写入 `~/AntBot/logs/app.log`）

### 重构
- `ipc.js` — 从 455 行扩展到 ~1100 行，集中了大量新业务逻辑
- `renderer/app.js` — 精简重构，新的 UI 组件模式
- `style.css` — 改为紧凑格式，新的配色方案（暖色调 `--brand: #D57E3C`）
- `preload.js` — 从 43 行扩展到 76 行，暴露更多 API

## IPC 频道参考

### 核心
| 频道 | 方向 | 说明 |
|------|------|------|
| `app:get-initial-state` | invoke | 获取初始状态 |
| `app:state` | push | 状态更新推送 |
| `app:log` | invoke | 写入 app 日志 |

### 任务
| 频道 | 方向 | 说明 |
|------|------|------|
| `task:start` | invoke | 启动任务 |
| `task:stop` / `task:stop-one` | invoke | 停止任务 |
| `task:resume-one` | invoke | 恢复任务 |
| `task:progress` | push | 任务进度推送 |
| `task:log` | push | 任务日志推送 |

### 语音克隆
| 频道 | 方向 | 说明 |
|------|------|------|
| `voice:clone` | invoke | 执行语音克隆 |
| `voice:clone-progress` | push | 克隆进度推送 |

### Voicebox 环境管理
| 频道 | 方向 | 说明 |
|------|------|------|
| `voicebox:check` | invoke | 检查 venv 和依赖状态 |
| `voicebox:install` | invoke | 安装依赖（逐包进度） |
| `voicebox:install-cancel` | invoke | 取消安装（按包名或全局） |
| `voicebox:open-dir` | invoke | 打开 venv 目录 |
| `voicebox:reset` | invoke | 重置 venv 环境 |
| `voicebox:progress` | push | 安装整体状态推送 |
| `voicebox:deps-progress` | push | 逐包安装进度推送 |

### 依赖管理
| 频道 | 方向 | 说明 |
|------|------|------|
| `deps:get-state` | invoke | 获取系统依赖状态 |
| `deps:repair` | invoke | 修复缺失依赖 |
| `deps:install` | invoke | 安装单个依赖（如 whisper） |
| `deps:install-progress` | push | 依赖安装进度 |

### 模型管理
| 频道 | 方向 | 说明 |
|------|------|------|
| `models:list` | invoke | 列出模型 |
| `models:download` | invoke | 下载模型 |
| `models:delete` | invoke | 删除模型 |
| `models:progress` | push | 模型下载进度 |

### 其他
| 频道 | 方向 | 说明 |
|------|------|------|
| `startup:check` | invoke | 启动检查 |
| `settings:update` | invoke | 更新设置 |
| `dialog:pick-audio-file` | invoke | 选择音频文件 |
| `dialog:pick-video-file` | invoke | 选择视频文件 |
| `history:get` | invoke | 获取历史记录 |

## 依赖安装进度事件格式

`voicebox:deps-progress` 频道发送的事件结构：

```js
{
  type: 'package-start' | 'package-progress' | 'package-done' | 'package-error' | 'package-cancelled' | 'all-done',
  name: 'torch',           // 原始包名
  normalizedName: 'torch', // 标准化包名
  constraint: '>=2.1.0',   // 版本约束
  percent: 45,             // 0-100
  speed: '5.2 MB/s',       // 下载速度
  size: '900 MB / 2.0 GB', // 已下载/总大小
  message: '下载中...',     // 状态描述
  timestamp: '...'         // ISO 时间戳
}
```

## 构建

```bash
npm install
npm run dev              # 本地运行
npm run build:mac        # macOS DMG
npm run build:win        # Windows NSIS
npm run build:linux      # Linux AppImage
```

产物输出到 `release/`。

## 关键设计决策

1. **voicebox 依赖安装**：Node.js 直接管理 pip 子进程，逐包安装，解析 stderr 获取进度/速度，AbortController 支持取消
2. **voicebox 源码获取**：Node.js fetch 下载 GitHub zip，Python zipfile 解压，不依赖 git/bash
3. **venv 路径**：`~/AntBot/voicebox-env/.venv-voicebox/`（与 auto_dub_web 项目分离）
4. **App 日志**：写入 `~/AntBot/logs/app.log`，同时 console 输出
5. **任务系统**：不再按用户隔离（v0.3.6 简化），统一队列

## 注意事项

- macOS 打包使用 `icons.png` 生成 `icon.icns`
- Playwright Chromium 通过 `postinstall` 自动安装
- `vendors/auto_dub_web` 随构建打包
- 语音克隆后端（voicebox）首次使用需安装 Python 依赖，耗时较长
