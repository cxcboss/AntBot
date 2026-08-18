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
- **合成阶段**（composing）：最多 1 个，调用 `smartEditor.composeEditVideo()`
- `_tick` 内合成与准备均为**后台点火（不 `await`）**：合成（Phase 2）与准备（Phase 1）真正并行——合成进行期间新任务可继续准备，ready 任务排队等合成
- `ready` 状态的任务自动排队等合成（每轮至多启动 1 个，串行保证合成互不重叠）
- `paused` 任务不参与调度，等用户手动继续

## 任务级配置

- `subtitle`（'开启'/'关闭'）在合成时生效：`t.subtitle === '关闭'` 时跳过字幕烧录
- `apiConfig` 不写入 `edit-tasks.json`（避免 API Key 明文落盘）；重启恢复时从全局设置重新填充
- 输出文件名时间戳含秒级精度，避免同分钟内同名视频互相覆盖

## 调度驱动

- 所有调度触发点（`startTask`/`startAll`/`retryTask`/任务结束）统一走 `_tick()`：以 `_running` 标志防重入，准备（`_runPrepare`）与合成（`_runCompose`）均为后台点火（不 `await`），合成完成时通过 `.finally` 再次触发 `_tick()` 接力下一个 ready 任务
- 有任一活跃任务（pending/preparing/ready/composing）时持续 `setTimeout(_tick, 500)` 轮询，全部结束后进入 `_maybeShutdownVoicebox()`（60 秒延迟关后端释放内存）

## 失败处理

- 失败任务置为 `failed`，不自动重试；用户手动点击"重试" → `retryTask()` 完全重置任务后重新调度（此时准备命中 `prepare-cache`，秒过）
- 主控流水线的自动重试（`settings.retry.failedTaskRetries`）由 `taskRunner.js` 负责，与 EditScheduler 无关

## 关键方法

| 方法 | 说明 |
|------|------|
| `addTask(data)` | 添加任务到队列 |
| `startTask(id)` | 开始/恢复单个任务 |
| `pauseTask(id)` | 暂停 preparing 状态的任务 |
| `cancelTask(id)` | 取消任务，清理任务级 clip-cache |
| `startAll()` | 开始所有 pending/paused 任务 |
| `_tick()` | 调度器核心：检查 ready → 后台点火合成，检查 pending → preparing（并行） |
| `retryTask(id)` | 手动重试失败任务（完全重置后重新调度） |
| `loadState()` / `saveState()` | 从 `edit-tasks.json` 持久化/恢复 |
| `shutdown()` | App 退出时中断活动任务并清理相关缓存 |

## 持久化

任务状态保存到 `~/AntBot/edit-tasks.json`（不含 `apiConfig`，密钥不落盘）。重启恢复时：
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
