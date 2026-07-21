# renderer/app.js — 渲染进程 UI

> 路径：`src/renderer/app.js`（~1300 行）

## 职责

所有前端 UI 逻辑：页面切换、数据渲染、事件绑定、状态管理。

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
  ...
}
```

## 页面结构

| 页面 | ID | 说明 |
|------|----|------|
| 主控 | view-main | 任务输入/历史/状态 |
| 剪辑 | view-edit | 视频队列/历史 |
| 风格参考 | view-style-ref | 风格管理 |
| 字幕与音色 | view-subtitle-voice | 字幕样式/音色克隆 |

## 剪辑流程

1. 添加视频 → `addEditVideos()` → 调用 `editAddTasks` IPC
2. 开始剪辑 → `editStartAll()` IPC → 调度器自动调度
3. 进度更新 → `onEditTaskUpdate` 监听 → `renderEditCards()`
4. 完成 → 保存到 `edit-history.json`

## 事件监听

- `onEditTaskUpdate` — 任务状态变化（从调度器推送）
- `onSmartEditProgress` — 剪辑详细进度
- `onVoiceboxProgress` — voicebox 安装进度
- `onVoiceboxDepsProgress` — 逐包安装进度
- `onProgress` — 主任务进度

## 注意事项

- 所有 UI 状态通过 `S` 全局对象管理
- `esc()` 函数用于 HTML 转义
- `injectIcons()` 在 DOM 更新后调用以注入 SVG 图标
- `renderStatus()` 根据 `S.currentFeat` 显示不同页面的状态文字
