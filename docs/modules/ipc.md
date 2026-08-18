# ipc.js — IPC Handler 注册中心

> 路径：`src/main/ipc.js`（~546 行）
> 子模块：`src/main/ipc/*.js`（8 个功能域模块）

## 职责

IPC handler 的注册中心。核心逻辑委托给 `ipc/` 子模块，本文件保留：
- 应用日志系统（`appLog`，按启动分文件，7 天自动清理）
- 窗口状态推送（`sendWindowState`、`buildInitialState`）
- 设置更新、依赖管理、任务控制、语音克隆、对话框等基础 handler

## IPC 子模块

| 模块 | 行数 | 通道前缀 | 说明 |
|------|------|----------|------|
| `ipc/voicebox.js` | ~384 | `voicebox:*` | voicebox 环境管理（check/install/reset/GPU） |
| `ipc/library.js` | ~417 | `styles:*`, `fonts:*`, `voices:*`, `ui:*`, `api:*`, `app:get-data-info` | 风格/字体/音色/UI 持久化、API 调用、数据迁移 |

> `voices:list`（2026-08 起）返回内置 Azure 音色（`source: 'azure'`，来自 `azureTts.js`）+ 克隆音色（`source: 'clone'`）合并列表；后端 profile 验证只过滤克隆音色，内置音色不受影响。`voices:save` 只写克隆音色（过滤 `azure:` 前缀）。
| `ipc/models.js` | ~292 | `models:*` | Whisper 模型管理（list/download/delete） |
| `ipc/publish.js` | ~211 | `publish:*`, `bridge:*` | 发布桥接服务、平台登录检测 |
| `ipc/remote.js` | ~169 | `remote:*`, `open-dir`, `open-plugin-dir` | 远程控制服务器、Cloudflare 隧道、凭证管理 |
| `ipc/edit.js` | ~150 | `edit:*`, `history:get` | 剪辑调度器（EditScheduler 实例化、任务 CRUD） |
| `ipc/download.js` | ~111 | `download:*` | 下载管理器（DownloadManager 实例化、yt-dlp） |
| `ipc/updates.js` | ~53 | `update:*`, `app:quit` | App/插件更新、退出 |

## 核心设计

- `appLog()` 函数全局可用，写入 `~/AntBot/logs/app-YYYY-MM-DDTHH-MM-SS.log`
- `mainWindowRef()` 获取主窗口引用，用于推送消息
- `store` 实例注入，通过 `registerIpcHandlers({ store, ... })`
- 子模块通过 `register({ ipcMain, store, mainWindowRef, appLog })` 注入依赖

## 生命周期

- `editScheduler` 由 `ipc/edit.js` 创建，返回给 `ipc.js` 用于 cleanup
- `downloadManager` 由 `ipc/download.js` 创建，返回给 `ipc.js` 用于 cleanup
- `cleanup()` 在 App 退出时调用：关闭 managed children、shutdown editScheduler、cleanup downloadManager

## 对接

- 渲染进程通过 `preload.js` 调用
- 业务逻辑委托给各 services 模块
- 状态变更通过 `webContents.send()` 推送
- App 退出时调用 `editScheduler.shutdown()`，中断活动剪辑任务并清理其缓存

## 任务解析（task:parse / task:start）

- `task:parse`：调用 `aiTaskParser.parseTaskInputSmart()`，返回 `{ tasks, warnings, source, defaults }`（旧版返回纯数组，契约已升级，见 `docs/modules/aiTaskParser.md`）
- `task:start`：同样走智能解析；兼容传入已解析任务数组（跳过解析）
- AI 解析使用设置页同一套 API 配置（`settings.api` 的 baseUrl/apiKeys/modelId），无 key 时自动降级规则解析
