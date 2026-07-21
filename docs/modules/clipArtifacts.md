# clipArtifacts.js - 剪辑缓存归属与清理

> 路径：`src/main/services/clipArtifacts.js`

## 职责

为智能剪辑流程提供唯一的缓存归属判断和清理入口。它只管理应用明确拥有的剪辑中间产物，不清理模型、依赖、设置、浏览器 profile、音色 profile 或最终成片。

## 缓存根

新剪辑任务使用：

```text
~/AntBot/clip-cache/<safe-task-id>/
```

任务目录可包含抽帧图、字幕、TTS 音频、混音轨、不完整合成输出和 `manifest.json`。

## 保护边界

删除前必须满足以下任一条件：

- 路径位于 `~/AntBot/clip-cache/` 内
- 路径是系统临时目录下的旧版 `antbot-smart-edit-*`

因此这些目录不会被归类为剪辑缓存：

- `~/AntBot/models/`
- `~/AntBot/voicebox-data/models/`
- `~/AntBot/voicebox-data/profiles/`
- `~/AntBot/voicebox-env/`
- `~/AntBot/browser-profiles/`

## 启动恢复

`reconcileEditTaskCaches()` 会在 App 启动加载 `edit-tasks.json` 时执行：

- `failed` / `cancelled` / `completed`：删除残留任务缓存
- `preparing` / `composing`：删除不完整缓存并重置为 `pending`
- `ready`：只有 SRT 仍存在且位于任务缓存中才保留，否则重置为 `pending`
- `paused`：删除中间缓存并重置为 `pending`
- orphan 任务目录：删除
- 旧版 `antbot-smart-edit-*`：删除
- 0 字节 `antbot-store.json.*.tmp`：删除

## 测试

覆盖文件：

- `src/main/services/tests/clipArtifacts.test.js`

