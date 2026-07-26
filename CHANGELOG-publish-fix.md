# 开发记录 — 发布功能修复 + UI优化

## 2026-07-26

### 发布功能修复

**问题：** 主控流水线发布步骤卡住，浏览器插件不执行命令。

**根因：** Chrome MV3 的 Service Worker 被自动终止（30秒无活动），导致 `setInterval` 轮询中断。插件 UI 显示"已连接"但实际未在轮询。

**修复方案：**
- **插件 v0.0.4**：端口保活（25秒自连）+ `chrome.alarms` 兜底（1分钟唤醒）
- **App**：移除 `extensionConnected` 检查，只检查桥接端口就绪即发送命令
- 发布超时从 30 分钟改为 60 秒

**验证：** 四个平台（YouTube/抖音/TikTok/B站）均可正常下载+剪辑+发布。

### UI 优化

| 改动 | 说明 |
|------|------|
| 任务卡片加宽 | max-width: 620px |
| 时间显示优化 | 当天只显示时间，昨天显示"昨天 HH:MM"，更早显示日期，跨年显示年份 |
| 完成卡片操作 | 显示"打开目录"按钮（revealInFolder） |
| 进度条条件显示 | 完成/失败/停止状态不显示进度条 |
| 定时标签 | 去掉背景框和主题色，改为普通灰色文字 |
| 原创标签 | 保留药丸样式（.task-tag-accent） |
| 显示原文+复制 | 展开原文后出现"复制"按钮，点击复制到剪贴板 |
| 失败任务重试 | 新增"重试"按钮，重新提交为新任务排到队尾 |

### 插件更新

- `publish-extension/chrome-extension/manifest.json`：版本 0.0.4，新增 `alarms` 权限
- `publish-extension/chrome-extension/background/background.js`：新增 `startKeepAlive()` + `startAlarmFallback()`

### 文件变更

| 文件 | 变动 |
|------|------|
| `publisher.js` | 发布超时改为60秒，日志增强 |
| `taskRunner.js` | 移除extensionConnected检查，简化发布等待逻辑 |
| `app.js` | 时间显示、任务卡片、复制按钮、重试逻辑 |
| `style.css` | 卡片加宽、标签样式、复制按钮、进度条条件显示 |
| `manifest.json` | 插件v0.0.4 |
| `background.js` | 端口保活+alarms兜底 |
