# smartEditor.js — AI 智能剪辑核心模块

> 路径：`src/main/services/smartEditor.js`

## 职责

负责智能剪辑的"准备阶段"：视频抽帧 → AI Vision 识别 → 生成 SRT 字幕 → AI 命名。

合成阶段委托给 `editor.js` → `autoDubClient.js`。

## 函数清单

### `prepareEditVideo(params)`
准备阶段主函数。参数：
- `videoPath` — 输入视频路径
- `taskId` — 任务 ID，用于定位 `~/AntBot/clip-cache/<task-id>`
- `stylePrompt` — 风格文案（来自 styleRefs）
- `apiConfig` — `{ baseUrl, apiKey, modelId }`
- `frameRate` — 抽帧频率（默认 1，即 1秒/帧）
- `abortSignal` — 取消信号

**返回：** `{ srtContent, srtPath, videoName, tmpDir, videoDuration, videoWidth, videoHeight }`

**流程：**
1. 计算准备缓存 key，命中则直接复用上次字幕（见下方「准备缓存」），跳过 2-5
2. `extractFrames()` — ffmpeg 抽帧，按源视频宽度压缩到 320-480px
3. `recognizeVideoContent()` — 每批最多 4 帧发 Vision API，带微进度
4. `generateSrt()` — AI 根据识别内容+风格生成 SRT；首次格式无效时自动请求一次严格 SRT 修复
5. `generateVideoName()` — AI 起 8 字以内中文名
6. 写入 `prepare-cache`、清理帧文件，返回 SRT

## 准备缓存（prepare-cache）

同一源视频 + 相同 风格/语言/帧率 的重复任务直接复用上次结果，跳过抽帧、Vision 调用和字幕生成：

- **key**：sha1( 视频路径 + mtime + size + 风格 prompt + 语言 + 帧率 )，视频内容未变则 key 稳定
- **存储**：`~/AntBot/prepare-cache/<key>.json`（保存 srtContent、videoName、时长、宽高）
- **失效**：源视频修改（mtime/size 变化）、风格/语言/帧率变化 → 自动 miss 重新生成
- **清理**：超过 7 天的缓存由 `cleanupStalePrepareCache()` 删除，随 `cleanupStaleCache()` 启动时调用
- 缓存读写失败不阻塞任务（静默降级为重新生成）

### `composeEditVideo(params)`
合成阶段。**直接调用 `editor.js` 的 `editVideo()`**，走原始 auto_dub_web 流程。

参数：
- `videoPath, srtPath, outputPath`
- `voiceProfileId, voiceProfileName` — 音色
- `voiceSpeed, subtitleStyle` — 语速/字幕样式

### `cleanupStaleCache()`
清理超过 1 小时的 `antbot-smart-edit-*` 临时目录，并顺带清理超过 7 天的 `prepare-cache` 缓存文件。

## 关键细节

- **图片压缩**：根据源视频宽度缩放到 320-480px，并调整 JPEG 质量以控制请求体大小
- **图片批次**：每个 Vision 请求最多 4 张图，兼容当前 API 的图片数量上限
- **微进度**：AI 识别每秒 +1%，避免进度条卡住
- **SRT 校验**：每句最少 1.5 秒，句间间隔按句子类型动态（80-600ms：叙述继续 80ms、插入语 150ms、感叹 600ms 等）；总时长超视频时**等比压缩**所有窗口与间隙保留相对节奏（不丢弃尾部字幕，2026-08 改进）
- **语音驱动时间轴微调**（2026-08，合成阶段 `videoComposer.js` 内）：TTS 合成后逐句 ffprobe 实测时长，按用户语速换算播放时长，重建字幕窗口使字幕与语音精确同步；保留 LLM 首句锚点与句间 gap 节奏，仅对窗口做局部微调抵消 TTS 时长误差，不改变语音速度
- **SRT 解析**：逐行识别字幕序号和时间线，不依赖字幕块之间的空行；兼容 `-->`、`->`、`→` 及逗号/句点毫秒
- **格式安全**：无法可靠解析的时间线会中止任务，禁止把序号或时间戳写入字幕正文和 TTS
- **自动修复**：首次响应没有有效时间线或格式异常时，携带原始响应和识别内容重试一次；修复结果仍必须通过严格解析
- **AbortSignal**：传递到 ffmpeg 和 fetch，取消立即生效
- **缓存目录**：`~/AntBot/clip-cache/<task-id>/`
- **失败清理**：准备阶段任何异常都会删除任务缓存；成功生成 SRT 后立即删除抽帧图

## 已废弃方案

- ~~直接调 voicebox TTS + ffmpeg 合成~~ → 改为委托 `editor.js`/`autoDubClient.js`，缓存归属由 `clipArtifacts.js` 管理
- ~~os.tmpdir()/antbot-smart-edit-*~~ → 新任务使用 `~/AntBot/clip-cache/<task-id>`，旧目录仅作为启动清理目标
- ~~图片 512px quality 5~~ → 请求体太大导致 UND_ERR_SOCKET
- ~~批次大小 15/8/5 帧~~ → 受上游接口限制，统一改为最多 4 帧

## API 调用（已抽取）

`callApiWithKeyRotation()` / `callApi()` 已抽取到 `apiClient.js`（多 key 轮询 + 429 切换 + 网络重试 + 用量统计 `recordUsage` + 代理支持）。smartEditor 引用 `./apiClient`，行为不变。`aiTaskParser.js` 复用同一通道。
