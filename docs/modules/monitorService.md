# monitorService.js — YouTube / TikTok 账号监控

> 路径：`src/main/services/monitorService.js`

## 职责

- 持久化监控配置到 `~/AntBot/monitors.json`
- 使用 `yt-dlp --flat-playlist` 拉取 YouTube 或 TikTok 公开账号最新视频，不下载视频本体
- 首次检查只记录已有视频；后续只对新视频创建任务并送入 `TaskRunner`
- 每个监控通过 `processMode` 选择仅下载、下载并剪辑或下载剪辑并发布
- 为每个监控维护独立的发布平台、话题、风格、音色、原创和活动覆盖配置
- 按监控频率维护定时检查，并在 App 退出时清理定时器

## 关键不变量

- 只接受 YouTube 频道/用户主页和 TikTok 公开账号主页；不接受单条视频、合集或私密链接
- `sourceType` 为 `youtube` 或 `tiktok`；视频去重键为 `${sourceType}:${videoId}`
- 新监控默认 `processMode: 'download'`；缺少该字段的旧监控迁移为 `publish` 以保持旧行为
- 检查期间使用监控 ID 防止并发重复检查；监控被删除或停用后，不再继续入队
- 新视频只有在任务成功入队后才写入 `seenIds`，入队失败时下次检查会重试
- `stats.totalQueued` 统计入队数量；旧版本的 `totalPublished` 字段会在读取时兼容迁移
- 所有 yt-dlp 子进程都设置超时、Windows 隐藏窗口和 `error/close` 兜底处理

## IPC

由 `src/main/ipc/monitor.js` 注册以下通道：

- `monitor:list`
- `monitor:add`
- `monitor:update`
- `monitor:remove`
- `monitor:check-now`
- `monitor:toggle`

检查、增删改配置完成后，主进程通过 `monitor:updated` 推送最新监控状态，渲染层无需轮询即可更新卡片。
