# 搬运蚁 (AntBot)

视频自动化工作台：下载 → 字幕生成 → 剪辑/配音 → 发布

## 功能

- **视频下载** — 支持 YouTube、抖音、TikTok、Bilibili（基于 yt-dlp）
- **智能剪辑** — AI 帧提取 + Vision API 生成字幕 + 自动配音
- **批量发布** — 通过 Chrome 插件发布到抖音、视频号
- **音色克隆** — 基于 Voicebox 的 TTS 引擎
- **远程控制** — Cloudflare 隧道穿透，手机远程操控
- **风格参考** — 内置 10 种内容风格模板

## 技术栈

- **Electron 35** — 桌面应用框架
- **Playwright** — 浏览器自动化
- **yt-dlp** — 视频下载
- **Voicebox** — Python TTS 引擎
- **Cloudflare Workers** — 远程控制中心

## 开发

```bash
npm install                    # 安装依赖 + playwright chromium
npm run dev                    # 本地运行
npm run build:mac              # macOS .app → 项目根目录（先读 docs/packaging.md）
npm run build:win              # Windows NSIS（仅用户明确要求时）
```

## 项目结构

```
├── src/
│   ├── main/                      # 主进程
│   │   ├── index.js               # 入口，窗口创建，生命周期
│   │   ├── ipc.js                 # IPC 注册中心
│   │   ├── ipc/                   # IPC 子模块（按功能域拆分）
│   │   ├── preload.js             # contextBridge 桥接
│   │   ├── taskRunner.js          # 主控任务执行引擎
│   │   └── services/              # 业务服务模块
│   ├── renderer/                  # 渲染进程
│   │   ├── index.html             # 单页应用壳
│   │   ├── app.js                 # 核心状态与主控页面
│   │   ├── app/                   # 页面模块（download, publish, remote, update）
│   │   ├── style.css              # 全局样式（组件库）
│   │   ├── design-tokens.css      # 设计 token
│   │   └── icons.js               # Lucide 图标
├── vendors/
│   ├── auto_dub_web/              # voicebox TTS 引擎（Python）
│   └── ms-playwright/             # Chromium 运行时
├── publish-extension/             # Chrome 发布插件 + 桥接服务
├── workers/antbot-hub/            # 远程控制 Cloudflare Worker
├── scripts/                       # 构建/批量脚本
└── docs/                          # 项目文档
```

## 文档

- `CLAUDE.md` — 项目规范、架构指南与设计系统（改代码前必读）
- `CHANGELOG.md` — 开发记录（时间线）
- `docs/README.md` — 文档总索引（功能 → 文档对照表）
- `docs/modules/` — 各服务模块文档
- `docs/packaging.md` — 打包规则与记录（打包前必读）
- `docs/release-guidelines.md` — 发布流程（发布前必读）
- `docs/remote-hot-update.md` — 远程页面热更新（改远程页面前必读）
- `docs/API.md` — App 本地 HTTP API（供 AI 操控）
- `docs/dev-notes-windows.md` — Windows 适配踩坑记录
