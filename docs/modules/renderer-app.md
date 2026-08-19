# renderer/app.js — 渲染进程 UI

> 路径：`src/renderer/app.js`（~2050 行）
> 子模块：`src/renderer/app/*.js`（4 个页面模块）

## 职责

所有前端 UI 逻辑：页面切换、数据渲染、事件绑定、状态管理。核心逻辑委托给 `app/` 子模块。

## 页面模块

| 模块 | 行数 | 说明 |
|------|------|------|
| `app/publish-page.js` | ~430 | 发布页：视频队列、平台选择、桥接服务、发布历史 |
| `app/download-page.js` | ~325 | 下载页：yt-dlp 管理、YouTube 登录、下载任务 |
| `app/update-page.js` | ~280 | 更新页：App/插件/远程页面更新检查与安装 |
| `app/remote-page.js` | ~148 | 远程页：Cloudflare 隧道、QR 码、凭证管理 |
| `app/monitor-page.js` | ~300 | 监控页：YouTube 博主监控、独立覆盖配置、立即检查 |

## 关键状态

```js
S = {
  app, settings, history, progress, deps,
  editVideos: [],        // 剪辑任务队列
  editDefaults: { style, voice, subtitle },
  editHistory: [],       // 剪辑历史
  editTab: 'queue',      // 'queue' | 'history'
  voices: [],            // 音色列表
  styleRefs: [],         // 风格参考
  currentFeat: 'main',   // 当前页面
  publish: null,         // 发布页状态（由 publish-page.js 初始化）
  downloadTasks: [],     // 下载任务（由 download-page.js 初始化）
  models: [],            // Whisper 模型
  ...
}
```

## 页面结构

| 页面 | ID | 模块 |
|------|----|------|
| 主控 | view-main | app.js（核心） |
| 剪辑 | view-edit | app.js（核心） |
| 发布 | view-publish | app/publish-page.js |
| 下载 | view-download | app/download-page.js |
| 监控 | view-monitor | app/monitor-page.js |
| 远程 | view-remote | app/remote-page.js |
| 更新 | view-update | app/update-page.js |
| 风格参考 | view-style-ref | app.js（核心） |
| 字幕与音色 | view-subtitle-voice | app.js（核心） |

## 模块集成模式

页面模块通过工厂函数创建，注入共享依赖：
```js
const downloadPage = createDownloadPage({ state: S, toast, esc, injectIcons });
const publishPage = createPublishPage({ state: S, esc });
```

在 `switchFeature()` 中调用 `init*()`，在 `bind()` 中调用 `bind*()`。

## 事件监听

- `onProgress` — 主任务进度
- `onEditTaskUpdate` — 剪辑任务状态变化
- `onVoiceboxProgress` — voicebox 安装进度
- `onVoiceboxDepsProgress` — 逐包安装进度
- `onDownloadTaskUpdate` — 下载任务更新
- `onPublishProgress` — 发布进度
- `onUpdateProgress` — 更新进度
- `onModelsProgress` — 模型下载进度

## 注意事项

- 所有 UI 状态通过 `S` 全局对象管理
- `esc()` 函数用于 HTML 转义
- `injectIcons()` 在 DOM 更新后调用以注入 SVG 图标
- `renderStatus()` 根据 `S.currentFeat` 显示不同页面的状态文字

## 主控输入预览（preview-bar）

- 输入框上方 `#preview-bar`（composer-preview）实时展示解析结果：任务数、来源标记（AI 优化/规则识别）、生效默认值（平台/原创/话题数/间隔）、前 5 条任务摘要（平台/原创/时间/活动/标题）、warnings
- `S.preview` 结构：`{ count, items, warnings, source, defaults, error, empty, mode, edited }`（items 为**全部**解析任务），由 `refreshPreview()`（160ms 防抖）→ `window.antbot.parseTasks(raw, opts)` 填充，`renderPreview()` 渲染
- **双模式**：`mode:'auto'` 直接发送走纯规则解析（`parseTasks(raw)` 无 smart，无 AI）；`mode:'optimized'` 点击 ✨ 优化按钮（`optimizeInput()` → `parseTasks(raw,{smart:true})` 带 AI）后进入，预览条底部出现「确定发送」按钮
- 输入为空时隐藏预览条
- **预览可编辑**：每行任务左侧 ✎ 按钮打开编辑面板（`openPvEditor`，chip-popup 风格）：平台（视频号/抖音/两者）、原创切换、时间（立即 / HH:mm / 明天 HH:mm，`parsePvTimeText` 解析）、标题、话题、活动，可删除单条；编辑后置 `S.preview.edited=true`
- `startTasks()` 提交逻辑：`mode==='optimized' || edited` → 提交预览任务数组（含用户修改）；否则提交**原始文本**（直接发送语义，纯规则路径，无 AI）；输入框内容变化后自动回到 auto 模式重新解析
- **右键清理历史**：聊天区 `#chat-stream` 上对 `.run-group` 右键弹出上下文菜单「删除此条记录（消息+任务）」（`window.antbot.clearHistory()` → `history:clear` IPC → `store.clearHistory()`），确认后清空 `S.history`/`S.pending` 并重渲染；运行中任务不受影响

## 主控时间线（chat-stream）

- **时间线组结构**：每条 run（消息+其任务）渲染为一个 `.run-group`，组间用分割线分隔；组内依次为 `.msg-time`（时间戳）、`.msg-user`（消息正文，**平铺无卡片**）、`.msg-rules`（可选规则折叠面板）、`.task-stack`（任务卡片）
- **消息操作行**：`.msg-actions` 内「原文/复制」按钮，hover 时淡入；点击「原文」展开未缩略文本（`.msg-raw`），点击「复制」写入剪贴板并反馈「已复制」；事件委托绑定在 `#chat-stream`（`data-msg-raw` / `data-msg-copy`）
- **规则面板**：发送时若走了预览规则（AI 优化或编辑过），`appendPending` 携带 `rules`（= `S.preview.items`），消息下方渲染 `.msg-rules` 折叠面板（`makeRulesHtml`）：头部摘要「已按规则解析 N 条任务 · 原创 X · 平台 Y」，展开显示每条任务的结构化规则（平台/原创/活动/定时/话题/标题）。**仅当前会话内有效**（`S.pending` 内存数据；重启后历史消息不保留规则面板）
- **任务卡片字段**：`taskCard(t)` 读取平台 `t.platforms || t.taskSnapshot.platforms`、原创 `t.isOriginal`、活动 `t.campaignName`、定时 `t.publishAt`、耗时 `t.duration`、执行配置 `t._exec`（`{styleName, voiceName, voiceover, subtitle}`，主进程 runTask 时快照写入）。元信息行展示平台/原创/活动/定时；「执行详情」展开区展示耗时/风格/音色/旁白/字幕
- **任务操作按钮**：完成/部分完成 →「打开目录」「重新发布」；运行中 →「取消」；排队 →「跳过」；失败 →「重试」
