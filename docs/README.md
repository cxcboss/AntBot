# AntBot 项目总文档

> 最后更新：2026-08-13 | 当前版本：以 `package.json` → `version` 为准（构建时固化）

## 模块关系总览

```
用户操作 (renderer/app.js)
    ↓ IPC
IPC 分发 (main/ipc.js → main/ipc/*.js)
    ↓
┌─────────────────────────────────────────────────────────┐
│  剪辑流程                                                │
│  editScheduler.js → smartEditor.js → editor.js          │
│       (调度/清理)     (AI准备)        (合成)             │
│                                    ↓                    │
│                              videoComposer.js           │
│                              (ffmpeg 直连合成)           │
│       clipArtifacts.js 管理 ~/AntBot/clip-cache          │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  语音克隆 / TTS                                          │
│  voiceClone.js → autoDubClient.js → voicebox backend    │
│    (流程控制)      (服务管理, 端口 17493)  (TTS引擎)       │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  发布                                                    │
│  publisher.js → browserPublishBridge.js → Chrome 插件    │
│    (回退 Playwright)   (桥接客户端)  (抖音/视频号)         │
│  桥接服务 local-server (端口 18321)                      │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  依赖管理                                                │
│  dependencyManager.js (系统依赖)                         │
│  dependencyInstaller.js (pip 逐包安装)                   │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  数据层                                                  │
│  store.js (设置/历史/用户 → ~/AntBot/antbot-store.json)  │
│  ~/AntBot/ (日志/音色/任务状态/模型)                      │
└─────────────────────────────────────────────────────────┘
```

## 功能 → 文档对照表

| 要改的功能 | 必读文档 |
|-----------|---------|
| 剪辑任务调度（开始/暂停/取消/队列） | [editScheduler.md](modules/editScheduler.md) |
| AI 智能剪辑（抽帧/识别/字幕/命名） | [smartEditor.md](modules/smartEditor.md) |
| 剪辑缓存归属与启动清理 | [clipArtifacts.md](modules/clipArtifacts.md) |
| 视频合成（ffmpeg / videoComposer） | [editor.md](modules/editor.md) |
| voicebox 服务管理与语音克隆 | [autoDubClient.md](modules/autoDubClient.md) |
| 语音克隆流程 | [voiceClone.md](modules/voiceClone.md) |
| 依赖安装（pip 逐包） | [dependencyInstaller.md](modules/dependencyInstaller.md) |
| 剪辑界面 UI（任务卡片/历史/按钮） | [renderer-app.md](modules/renderer-app.md) |
| IPC 频道定义 | [ipc.md](modules/ipc.md) |
| 数据持久化 | [store.md](modules/store.md) |
| 主控任务解析（AI/规则） | [aiTaskParser.md](modules/aiTaskParser.md) |
| 视频发布（插件桥接 + Playwright） | [publisher.md](modules/publisher.md) |
| App HTTP API（供 AI 操控） | [API.md](API.md) |
| 远程页面热更新 | [remote-hot-update.md](remote-hot-update.md) |

## 改完代码后必须做的事

1. **改了模块内部逻辑** → 更新对应模块的 md 文件
2. **改了模块间接口** → 更新本文档的模块关系图 + 对应两个模块的 md
3. **新增/删除 IPC 频道** → 更新 [ipc.md](modules/ipc.md)
4. **改了数据结构** → 更新 [store.md](modules/store.md)
5. **改了 UI** → 更新 [renderer-app.md](modules/renderer-app.md)
6. **打包/发布** → 先读 [packaging.md](packaging.md) 和 [release-guidelines.md](release-guidelines.md)

## 数据目录结构

```
~/AntBot/
├── voicebox-env/           语音克隆 Python venv（torch 等）
├── voicebox-data/          voicebox 后端数据（固定路径）
│   ├── voicebox.db         语音档案数据库
│   ├── profiles/           音色档案（ref.wav 等）
│   └── models/             TTS 模型
├── clip-cache/             剪辑中间产物（任务结束或启动恢复时清理）
├── prepare-cache/          准备阶段缓存（SRT/命名，秒过重试）
├── edit-tasks.json         剪辑任务状态持久化
├── edit-history.json       剪辑历史记录
├── main-control-tasks.json 主控任务持久化（warning/completed）
├── antbot-store.json       设置/历史/用户（单一文件）
├── voices.json             音色列表（与 voicebox 后端同步验证）
├── api-usage.json          API key 每日用量
├── style-refs.json         风格参考数据
├── logs/                   App 日志（按启动分文件，7天自动清理）
├── models/                 AI 模型存储
├── thumbnails/             视频预览图缓存（MD5 文件名）
├── remote-credentials.json 远程凭证（safeStorage 加密）
├── remote-ui/              远程页面本地缓存（热更新）
├── browser-plugin/         浏览器插件本地副本
└── browser-profiles/       Playwright 浏览器 profile
```

## 已废弃的方案

| 方案 | 废弃原因 |
|------|---------|
| auto_dub_web Node.js 合成服务（server.mjs, port 5001） | 已删除，合成改 `editor.js → videoComposer.js` 直连 ffmpeg（复用 voicebox TTS） |
| voicebox 数据目录在项目路径下 | 项目路径变化导致数据库丢失，改到 `~/AntBot/voicebox-data/` |
| 强制竖屏输出（1080×1920 模糊背景） | 用户要求原比例输出 |
| Electron userData 路径管理 voicebox venv | 与 ipc.js 路径不一致，统一到 `~/AntBot/voicebox-env/` |
| `File.path` 获取拖拽文件路径 | Electron 35 已废弃，改用 `webUtils.getPathForFile()` |
| 剪辑 TTS 使用 `/generate` + `/audio/{id}` | 会留下 `voicebox-data/generations` 历史 WAV，改用 `/generate/stream` |
| 智能剪辑缓存写入 `os.tmpdir()/antbot-smart-edit-*` | 归属不清且崩溃后难恢复，改到 `~/AntBot/clip-cache/<task-id>` |
| 按用户拆目录存 store（`users/{userId}/store.json`） | 统一为单文件 `~/AntBot/antbot-store.json` |
