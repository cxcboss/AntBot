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
- `onSmartEditProgress` — 剪辑详细进度
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
