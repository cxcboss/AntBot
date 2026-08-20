# taskState.js — 主控任务身份与历史归并

> 路径：`src/main/services/taskState.js`

## 职责

提供主控任务的纯逻辑工具：

- 兼容 `id`、`taskId`、`taskSnapshot.id` 等历史字段
- 用 `logicalTaskId` 标识同一任务的多次执行
- 为重试任务生成新的执行 ID，同时保留 `retryOf`
- 按尝试次数和完成时间归并历史任务卡片
- 将重新发布结果匹配回历史记录

## 兼容规则

新任务优先使用 `logicalTaskId`；旧数据没有该字段时回退到 `taskId`、`id` 或快照 ID。渲染端和主进程各自实现相同字段优先级，以保证桌面端、远程端和重启后的数据一致。
