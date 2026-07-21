# editScheduler.js — 剪辑任务流水线调度器

> 路径：`src/main/services/editScheduler.js`

## 职责

管理剪辑任务的生命周期：排队、并行准备、串行合成、暂停/取消/恢复、状态持久化。

## 状态机

```
pending → preparing → ready → composing → completed
  ↑         ↓           ↓        ↓
  └── paused ←──────────┘        ↓
  └── cancelled ←────────────────┘
  └── failed ←───────────────────┘
```

## 流水线规则

- **准备阶段**（preparing）：最多 2 个并发，调用 `smartEditor.prepareEditVideo()`
- **合成阶段**（composing）：最多 1 个串行，调用 `smartEditor.composeEditVideo()`
- `ready` 状态的任务自动排队等合成
- `paused` 任务不参与调度，等用户手动继续

## 关键方法

| 方法 | 说明 |
|------|------|
| `addTask(data)` | 添加任务到队列 |
| `startTask(id)` | 开始/恢复单个任务 |
| `pauseTask(id)` | 暂停 preparing 状态的任务 |
| `cancelTask(id)` | 取消任务，清理任务级 clip-cache |
| `startAll()` | 开始所有 pending/paused 任务 |
| `_tick()` | 调度器核心：检查 ready → composing，检查 pending → preparing |
| `loadState()` / `saveState()` | 从 `edit-tasks.json` 持久化/恢复 |
| `shutdown()` | App 退出时中断活动任务并清理相关缓存 |

## 持久化

任务状态保存到 `~/AntBot/edit-tasks.json`。重启恢复时：
- `preparing` / `composing` → 清理任务缓存，重置为 `pending`
- `ready` → 仅当 SRT 仍存在且位于 `~/AntBot/clip-cache/<task-id>/` 时保留
- `completed` / `failed` / `cancelled` → 保留任务记录，删除残留任务缓存
- orphan `clip-cache` 目录和旧版 `antbot-smart-edit-*` 会在启动时清理

## IPC 频道

| 频道 | 说明 |
|------|------|
| `edit:add-tasks` | 批量添加任务 |
| `edit:start-task` / `edit:pause-task` / `edit:cancel-task` | 单任务控制 |
| `edit:start-all` | 批量开始 |
| `edit:get-tasks` | 获取所有任务状态 |
| `edit:task-update` (push) | 任务状态变化推送 |

## AbortController 管理

每个任务创建独立的 AbortController，存储在 `abortControllers` Map 中。
- 准备阶段取消：中断 API 调用和 ffmpeg
- 合成阶段取消：标记取消；若合成进程稍后返回，会删除输出副本和任务缓存
- 任务完成后自动 delete

## 缓存清理

调度器通过 `clipArtifacts.js` 管理剪辑中间产物：

- 准备失败、取消、暂停：删除抽帧、SRT、manifest 等任务缓存
- 合成失败、取消：删除 TTS/混音/不完整输出和任务缓存
- 合成成功：只保留最终输出视频和历史元数据，删除任务缓存
- 移除任务：先走取消清理，再删除队列记录
