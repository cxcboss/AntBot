# 开发记录 — 视频下载功能

## 2026-07-25: 下载功能实现 + YouTube 不可播放修复

### 功能概述

在侧边栏新增「下载」功能，支持 YouTube、抖音、TikTok、B站视频下载。

### 技术方案

**下载工具：** yt-dlp (brew 安装，版本 2026.07.04)
**合并工具：** ffmpeg (brew 安装)
**Cookies 管理：** Playwright 后台获取 + Electron BrowserWindow 登录

### 各平台下载策略

| 平台 | 格式选择 | Cookies | 特殊参数 |
|------|---------|---------|---------|
| YouTube | `bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]` 优先 H.264+AAC | 用户通过 Electron BrowserWindow 登录后提取，保存到 `~/AntBot/cookies/youtube.txt` | `--remote-components ejs:github` |
| 抖音 | `bestvideo+bestaudio/best` | Playwright 后台访问 douyin.com 获取，保存到 `~/AntBot/cookies/douyin.txt`，24小时缓存 | 无 |
| TikTok | `bestvideo+bestaudio/best` | 不需要 | 无 |
| B站 | `bestvideo+bestaudio/best` | 不需要 | 无 |

### YouTube 不可播放问题

**原因：** YouTube 默认下载 AV1 视频 + Opus 音频，这两种编码在 macOS QuickTime 等播放器上不兼容。

**修复：** 格式选择优先 H.264 (`vcodec^=avc1`) + AAC (`acodec^=mp4a`)，降级到 AV1+bestaudio，最终 fallback 到 best。

**验证：** `ffprobe` 确认输出为 `Video: h264 (High)` + `Audio: aac (LC)`。

### 命名规则

`{平台前缀}_{月日}_{时分秒毫秒}.mp4`

| 平台 | 前缀 | 示例 |
|------|------|------|
| YouTube | yt | yt_725_143025_001.mp4 |
| 抖音 | dy | dy_725_143028_002.mp4 |
| TikTok | tk | tk_725_143030_003.mp4 |
| B站 | b | b_725_143030_004.mp4 |

### UI 设计

- 卡片布局：类聊天消息，平台标签 + 文件名 + 状态 / 原链接（横向滚动）/ 时间
- 等待动画：「准备.」「准备..」「准备...」循环，400ms 间隔
- 下载中：数字百分比 + 速度（无进度条）
- 多选：Shift+点击多选，底部「全选」「清理选中」按钮
- 右键菜单：重试/取消/打开文件/删除文件/清理记录
- YouTube 登录提示：首次打开（无 cookies 时）显示，可跳过
- 排序：最旧在上，最新在下（类聊天顺序）

### 文件变更

| 文件 | 变动 |
|------|------|
| `src/main/services/downloadManager.js` | **新建** — 下载管理器（并发控制、平台识别、cookies 管理、进度解析） |
| `src/main/ipc.js` | 新增 9 个 IPC handlers（download:*） |
| `src/main/preload.js` | 新增 9 个桥接方法 |
| `src/renderer/index.html` | 新增下载页面 HTML |
| `src/renderer/style.css` | 新增下载页面样式 |
| `src/renderer/app.js` | 新增下载页面逻辑（渲染、交互、多选、右键菜单） |

### 测试结果

| 平台 | 状态 | 视频编码 | 音频编码 | 可播放 |
|------|------|---------|---------|--------|
| YouTube | ✅ | H.264 (avc1) | AAC | ✅ |
| 抖音 | ✅ | H.265/AV1 | AAC | ✅ |
| TikTok | ✅ | H.265 | AAC | ✅ |
| B站 | ✅ | H.264 | AAC | ✅ |
