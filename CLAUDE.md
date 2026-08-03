# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 回答风格（永久规则）

回答必须简洁、突出重点：不要贴代码（除非用户要求）、不要重复用户已知道的信息、不要客套话；方案用短清单，改动直接说结论。

## Project

AntBot（搬运蚁）is an Electron desktop app for video automation: download → subtitle generation → editing/dubbing → publishing.

## Build & Run

```bash
npm install                    # installs deps + playwright chromium
npm run dev                    # run locally
npm run build:mac              # macOS DMG → release/
npm run build:win              # Windows NSIS
```

The `postinstall` hook runs `playwright install chromium`. The build script runs `prepare:icon:mac` and `prepare:voicebox` before `electron-builder`.

## Architecture

**Electron two-process model:**
- **Main process** (`src/main/`) — business logic, IPC handlers, service modules
  - `ipc.js` — IPC 注册中心，委托给 `ipc/*.js` 子模块
  - `ipc/` — 按功能域拆分的 IPC handler 模块（voicebox, download, edit, publish, remote, updates, models, library）
- **Renderer** (`src/renderer/`) — UI only, communicates via `window.antbot` bridge
  - `app.js` — 核心状态、主控页面、事件绑定，委托给 `app/*.js` 子模块
  - `app/` — 按页面拆分的 ES 模块（download-page, publish-page, remote-page, update-page）
- **Preload** (`src/main/preload.js`) — `contextBridge.exposeInMainWorld('antbot', {...})` maps IPC channels

**IPC pattern:** Renderer calls `window.antbot.methodName()` → `ipcRenderer.invoke(channel)` → `ipcMain.handle(channel)` in `ipc.js` or `ipc/*.js` sub-modules. Push events: `webContents.send(channel)` → `ipcRenderer.on(channel)` via preload `on()` helper.

**Smart edit pipeline (two-phase):**
```
prepareEditVideo (smartEditor.js)     →  { srtContent, srtPath, videoName, tmpDir }
  extractFrames → AI Vision → generateSrt → generateVideoName

composeEditVideo (smartEditor.js)     →  { outputPath }
  delegates to editVideo (editor.js) → processWithAutoDub (autoDubClient.js)
```

**Edit scheduler** (`editScheduler.js`): manages task lifecycle with states `pending → preparing → ready → composing → completed`. Preparation runs up to 2 concurrently; composition runs sequentially. State persisted to `~/AntBot/edit-tasks.json`.

**Voicebox backend** (Python, port 17493): TTS engine. Started by `autoDubClient.js`. Data stored at `~/AntBot/voicebox-data/` (fixed path, survives project rebuilds). Venv at `~/AntBot/voicebox-env/.venv-voicebox/`.

**auto_dub_web** (Node.js, port 5001): video composition server at `vendors/auto_dub_web/server.mjs`. Handles TTS synthesis + subtitle burning + audio mixing.

## Key Paths

| Path | Purpose |
|------|---------|
| `~/AntBot/` | All user data (settings, history, logs, models, voicebox) |
| `~/AntBot/logs/app-*.log` | Per-launch log files (7-day auto-clean) |
| `~/AntBot/edit-tasks.json` | Edit task state persistence |
| `~/AntBot/voices.json` | Voice profiles (synced with voicebox backend) |
| `~/AntBot/api-usage.json` | API key daily usage tracking |

## Critical Rules

- **Module docs:** Read `docs/modules/*.md` before modifying any service module. Update the doc after changing module behavior.
- **远程页面热更新:** 修改远程控制页面（remote-ui、Hub 页面）前必须先读 `docs/remote-hot-update.md`，了解热更新机制、GitHub 仓库、版本号更新流程和 checklist。
- **发布准则:** 发布 App、浏览器插件、远程页面更新前必须先读 `docs/release-guidelines.md`，遵守版本号规范、打包要求和发布流程。
- **No gradients:** CSS uses solid colors only. Theme color `var(--primary)` only on key interactive elements.
- **Design system:** All UI changes MUST follow the design system defined below. Read the "Design System" section before modifying any CSS or adding new components.
- **No `File.path`:** Electron 35 deprecated it. Use `window.antbot.getPathForFile(file)` (exposes `webUtils.getPathForFile`).
- **ffmpeg/ffprobe path resolution:** App runs from Electron where `/opt/homebrew/bin` may not be in PATH. Always use `resolveFfmpegBin()` pattern (check `/opt/homebrew/bin`, `/usr/local/bin`, then bare name).
- **Spawn args:** Never concatenate flags with values in a single string (e.g., `'-q:v 3'` → split to `'-q:v', '3'`). ffmpeg receives it as one arg and fails with exit 234.
- **Voicebox lifecycle:** Must call `shutdownVoicebox()` after composition completes (success or failure) to release ~37GB memory from the TTS model.
- **Data directory consistency:** voicebox venv at `~/AntBot/voicebox-env/`, voicebox data at `~/AntBot/voicebox-data/`. Both use `path.join(os.homedir(), 'AntBot')`, NOT `app.getPath('userData')`.
- **Settings auto-save:** `fillForm()` rebuilds DOM from `S.settings`. Any dynamic DOM (added inputs, etc.) will be destroyed. Don't call `saveSettings()` immediately after DOM mutations.

## Service Modules Quick Reference

| Module | Key Function | Notes |
|--------|-------------|-------|
| `smartEditor.js` | `prepareEditVideo`, `composeEditVideo` | AI frame extraction uses Vision API; composition delegates to `editVideo` |
| `editScheduler.js` | `EditScheduler` class | Pipeline: 2 concurrent prepares, 1 sequential compose |
| `autoDubClient.js` | `processWithAutoDub`, `ensureVoiceCloneBackend` | Manages both auto_dub_web and voicebox processes |
| `dependencyInstaller.js` | `installDependencies` | Parses pip stderr for progress; `PYTHONUNBUFFERED=1` required |
| `voiceClone.js` | `runVoiceClone` | Thin wrapper; delegates to `autoDubClient` |
| `store.js` | `getSettings`, `updateSettings` | Deep-merge settings; persisted per-user |

## Design System

**基于 shadcn/ui 设计理念。所有新增 UI 或样式改动必须遵守以下规范。**

设计 token 定义在 `src/renderer/design-tokens.css`，通过 CSS 变量全局生效。图标使用 [Lucide Icons](https://lucide.dev)（`lucide-static` 包），定义在 `src/renderer/icons.js`。

### 主题色

| Token | 亮色 | 暗色 | 用途 |
|-------|------|------|------|
| `--primary` | `#0D9488` (Teal-600) | `#5EEAD4` (Teal-300) | 按钮、强调、链接 |
| `--primary-hover` | `#0F766E` | `#99F6E4` | hover 态 |
| `--accent` | `#F0FDFA` | `#134E4A` | 选中背景、激活态 |
| `--accent-foreground` | `#0D9488` | `#5EEAD4` | 选中文字 |

### 语义色

| Token | 色值 | 用途 |
|-------|------|------|
| `--success` | `#16A34A` / `#22C55E` | 成功状态、完成 |
| `--destructive` | `#DC2626` / `#EF4444` | 错误、删除、危险操作 |
| `--warning` | `#D97706` / `#F59E0B` | 警告、进行中 |
| `--info` | `#2563EB` / `#3B82F6` | 信息提示 |

每个语义色都有对应的 `-bg` 背景色和 `-foreground` 前景色。

### 基础色

| Token | 亮色 | 暗色 | 用途 |
|-------|------|------|------|
| `--background` | `#FAFAFA` | `#09090B` | 页面底色 |
| `--card` | `#FFFFFF` | `#111113` | 卡片、面板、侧边栏 |
| `--foreground` | `#0A0A0A` | `#FAFAFA` | 主文字 |
| `--muted-foreground` | `#78716C` | `#A1A1AA` | 次要文字、标签 |
| `--border` | `#E7E5E2` | `#27272A` | 边框、分割线 |
| `--muted` | `#F0EDE8` | `#1C1C1F` | 静默背景、hover |
| `--secondary` | `#F5F3F0` | `#1C1C1F` | 次级背景 |
| `--input` | `#E7E5E2` | `#27272A` | 输入框边框 |
| `--ring` | `#0D9488` | `#5EEAD4` | focus ring |

### 圆角

```css
--radius-xs:   4px    /* badge、tag */
--radius-sm:   6px    /* 小按钮 */
--radius:      8px    /* 默认：输入框、按钮 */
--radius-lg:   12px   /* 卡片、弹窗内容区 */
--radius-xl:   16px   /* 对话框、大卡片 */
--radius-full: 9999px /* 药丸形：进度条、badge */
```

**规则：** 不要使用 `--r-sm` / `--r-md` / `--r-lg`（已废弃别名），直接用新 token。

### 阴影

```css
--shadow-xs:  0 1px 2px rgba(0,0,0,0.04)                        /* 卡片静止 */
--shadow-sm:  0 1px 3px rgba(0,0,0,0.06), 0 1px 2px ...         /* 按钮、小浮层 */
--shadow:     0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px ...    /* 下拉菜单 */
--shadow-md:  0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px ...  /* 弹出层 */
--shadow-lg:  0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px ...  /* 对话框、Toast */
```

**规则：** 不要硬编码 `box-shadow` 值，统一使用 shadow token。

### 过渡动画

```css
--transition-fast:   120ms cubic-bezier(0.4, 0, 0.2, 1)  /* hover、focus */
--transition-normal: 200ms cubic-bezier(0.4, 0, 0.2, 1)  /* 展开/折叠 */
--transition-slow:   300ms cubic-bezier(0.4, 0, 0.2, 1)  /* 进度条、页面过渡 */
```

**规则：** 不要硬编码 `transition` 时间和缓动函数，统一使用 transition token。

### 间距

基于 4px 网格。可用 token：`--space-1`(4) / `--space-2`(8) / `--space-3`(12) / `--space-4`(16) / `--space-5`(20) / `--space-6`(24) / `--space-8`(32) / `--space-10`(40) / `--space-12`(48)。

**规则：** 不要使用 5px、7px、9px、10px、11px、14px 等非 4px 倍数值。最接近的 4px 倍数即可。

### 排版

```css
--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Inter", sans-serif
--font-mono: "SF Mono", "Fira Code", "JetBrains Mono", monospace
```

| 用途 | 字号 | 字重 |
|------|------|------|
| 页面标题 (h1) | 18px | 700 |
| 区块标题 (h2) | 16px | 600 |
| 卡片标题 (h3) | 15px | 600 |
| 正文 | 13px | 400 |
| 辅助文字 | 12px | 400 |
| 标签/徽章 | 11px | 500 |
| 极小文字 | 10px | 400 |

### 组件规范

**按钮** — 3 种尺寸 + 4 种变体：
- `sm`: h-28px, px-10px, text-12px, `--radius-sm`
- 默认: h-32px, px-14px, text-13px, `--radius`
- `lg`: h-36px, px-18px, text-14px, `--radius`
- 变体: `.btn-primary` / `.btn-ghost` / `.btn-danger` / `.btn-sm`
- 所有按钮必须有 `focus-visible` 样式：`outline: 2px solid var(--ring); outline-offset: 2px`

**输入框** — 统一 h-32px, `--radius`, `--input` 边框, focus 时 `--ring` 边框 + `box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 15%, transparent)`

**卡片** — `--card` 背景, `--border` 边框, `--radius-lg` 圆角, `--shadow-xs` 静止阴影, hover 时边框变深

**对话框** — `--radius-xl` 圆角, `backdrop-filter: blur(4px)`, `--shadow-lg` 阴影, `--popover` 背景

**Toast** — `--radius-lg` 圆角, `--shadow-lg` 阴影, 宽度 320px, 各状态用对应语义色

### 暗色模式

自动跟随系统 `prefers-color-scheme`，通过 `matchMedia` 监听实时切换。`document.documentElement.classList.toggle('dark', isDark)`。

**规则：** 不要添加手动切换按钮。不要使用 `@media(prefers-color-scheme:dark)` 做暗色适配——所有暗色变量在 `.dark` 选择器中定义。

### 图标

使用 `lucide-static` 包。在 `src/renderer/icons.js` 中注册，HTML 中通过 `data-icon="name"` 使用，JS 中通过 `injectIcons()` 渲染。

**新增图标的步骤：**
1. 在 `icons.js` 顶部 import 中添加 Lucide 图标名
2. 在 `ICONS` 对象中添加映射（使用 `clean()` 或 `sm()` 包装）
3. HTML 中使用 `<span class="icon" data-icon="xxx"></span>`

### 禁止事项

- ❌ 不使用渐变（gradient）
- ❌ 不硬编码颜色值（必须用 CSS 变量）
- ❌ 不硬编码阴影/圆角/过渡值（必须用 token）
- ❌ 不过度使用主题色（仅关键交互元素）
- ❌ 不使用 `@media(prefers-color-scheme:dark)`（用 `.dark` class）
- ❌ 不使用废弃别名 `--brand` / `--bg` / `--surface` / `--t2` / `--t3` / `--r-sm` 等

## Windows 适配要点

**安装目录只读**：Windows 上 App 默认装在 `C:\Program Files\AntBot\`，该目录及 `process.resourcesPath` 对非管理员用户**只读**。任何写操作（npm install、创建目录、写文件）都不能指向安装目录。

**写入位置规则**：
- 所有用户数据写入 `~/AntBot/`（`os.homedir() + 'AntBot'`）
- 依赖工具下载到 `app.getPath('userData')/bin/`（通过 `dependencyManager`）
- 需要写入的 bundled 资源必须先复制到 `~/AntBot/` 再使用（如 `bridgeServiceManager` 的 local-server）

**spawn/exec 规则**：
- 所有 `spawn()` 必须加 `windowsHide: true`，否则会闪命令窗口并阻塞主进程
- `execSync()` 同样需要 `windowsHide: true`
- 不要用 `execSync('npm install', { stdio: 'inherit' })` — 用 `spawn` + `windowsHide`

**工具路径解析**：
- 不要写死 macOS 路径（`/opt/homebrew/bin`、`/usr/local/bin`）
- 统一用 `dependencyManager.resolveDependencyPath(name)` 解析工具路径（异步，必须 `await`）
- `resolveDependencyPath` 返回 Promise，不加 `await` 会传给 spawn 一个 `[object Promise]`
- Windows 上 `python3` 不存在，用 `python` 或 `py`
- Windows 上 `unzip` 不存在，用 `powershell Expand-Archive`

**PATH 处理**：
- 路径拼接用 `path.join()`，不要用 `/` 硬编码
- PATH 分隔符用 `path.delimiter`（Windows 是 `;`，Unix 是 `:`）
- 不要往 PATH 加 Unix 路径（`/opt/homebrew/bin`）在 Windows 上

**平台判断**：
- `process.platform === 'win32'` 表示所有 Windows（包括 64 位），不是 32 位
- `process.platform === 'darwin'` 表示 macOS

**NSIS 安装器**：
- `win.productName` 不是合法配置，用 `win.executableName` 控制 exe 文件名
- Windows 的 `productName` 用英文避免中文路径编码问题
- 需要 `.ico` 格式图标（从 1024x1024 PNG 生成，包含 16-256 尺寸）

**更新机制**：
- Windows 不支持 zip 解压替换 exe（文件锁定），更新走浏览器下载 NSIS 安装器
- `checkAppUpdate()` 在 Windows 返回 `openBrowser: true` + 下载链接

### Issue tracker

本地 markdown 文件，存放在 `.scratch/<feature>/` 目录。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认标签：needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局。See `docs/agents/domain.md`.
