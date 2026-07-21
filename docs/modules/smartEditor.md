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

**返回：** `{ srtContent, srtPath, videoName, tmpDir, videoDuration }`

**流程：**
1. `extractFrames()` — ffmpeg 抽帧，按源视频宽度压缩到 320-480px
2. `recognizeVideoContent()` — 每批最多 4 帧发 Vision API，带微进度
3. `generateSrt()` — AI 根据识别内容+风格生成 SRT
4. `generateVideoName()` — AI 起 8 字以内中文名
5. 清理帧文件，返回 SRT

### `composeEditVideo(params)`
合成阶段。**直接调用 `editor.js` 的 `editVideo()`**，走原始 auto_dub_web 流程。

参数：
- `videoPath, srtPath, outputPath`
- `voiceProfileId, voiceProfileName` — 音色
- `voiceSpeed, subtitleStyle` — 语速/字幕样式

### `cleanupStaleCache()`
清理超过 1 小时的 `antbot-smart-edit-*` 临时目录。

## 关键细节

- **图片压缩**：根据源视频宽度缩放到 320-480px，并调整 JPEG 质量以控制请求体大小
- **图片批次**：每个 Vision 请求最多 4 张图，兼容当前 API 的图片数量上限
- **微进度**：AI 识别每秒 +1%，避免进度条卡住
- **SRT 校验**：每句最少 1.5 秒，句间间隔 ≥ 0.3 秒，总时长不超视频
- **SRT 解析**：逐行识别字幕序号和时间线，不依赖字幕块之间的空行；兼容 `-->`、`->`、`→` 及逗号/句点毫秒
- **格式安全**：无法可靠解析的时间线会中止任务，禁止把序号或时间戳写入字幕正文和 TTS
- **AbortSignal**：传递到 ffmpeg 和 fetch，取消立即生效
- **缓存目录**：`~/AntBot/clip-cache/<task-id>/`
- **失败清理**：准备阶段任何异常都会删除任务缓存；成功生成 SRT 后立即删除抽帧图

## 已废弃方案

- ~~直接调 voicebox TTS + ffmpeg 合成~~ → 改为委托 `editor.js`/`autoDubClient.js`，缓存归属由 `clipArtifacts.js` 管理
- ~~os.tmpdir()/antbot-smart-edit-*~~ → 新任务使用 `~/AntBot/clip-cache/<task-id>`，旧目录仅作为启动清理目标
- ~~图片 512px quality 5~~ → 请求体太大导致 UND_ERR_SOCKET
- ~~批次大小 15/8/5 帧~~ → 受上游接口限制，统一改为最多 4 帧
