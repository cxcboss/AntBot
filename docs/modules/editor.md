# editor.js — 视频合成模块

> 路径：`src/main/services/editor.js`

## 职责

接收视频+SRT+设置，调用 videoComposer 完成 TTS 合成 + 字幕烧录 + 音频混合。

## 核心函数

### `editVideo(taskContext)`
参数：`{ task, settings, inputVideoPath, subtitlePath, outputPath, abortSignal, log, progress }`

**流程：**
1. 校验视频、字幕和输出路径
2. 按音色来源分流（新增，2026-08）：
   - 音色为内置 Azure TTS（`voiceClone.voiceId` 以 `azure:` 前缀，如 `azure:zh-CN-XiaoxiaoNeural`）→ 走 Azure 模式，**不启动 voicebox 后端**，`ttsMode='azure'`，传 `azureVoiceId`
   - 音色为克隆音色 → 调用 `autoDubClient.resolveVoiceCloneProfile()`：确保 Voicebox 后端运行，并把设置中可能失效的 voiceId 解析/自动恢复为后端实际存在的档案（按 ID → 名称 → 唯一档案 → 样本自动重新注册 依次兜底，覆盖换盘安装/升级/后端数据重建导致的 `404 Profile not found`）
   - 无音色 → 系统语音（macOS `say`）
3. 调用 `videoComposer.composeVideoWithDub()` 执行合成

**settings 结构：**
```js
{
  style: { voiceoverEnabled, subtitleEnabled, voiceSpeed, subtitleTextColor, subtitleStrokeColor, subtitlePositionPercent, subtitleFontSize },
  voiceClone: { voiceId, profileName, language, gpuMode }
}
```

## 对接关系

- 被 `smartEditor.composeEditVideo()` 调用
- 调用 `videoComposer.composeVideoWithDub()` 执行实际合成
- 调用 `autoDubClient.resolveVoiceCloneProfile()`（内部才确保 Voicebox 后端运行）

## 注意事项

- `voiceoverEnabled=false` 时不会调用 TTS
- `subtitleEnabled` 依赖 `voiceoverEnabled`（旁白关则字幕也关）
- 输出路径由调用方决定，不在此模块创建目录
- `abortSignal` 透传给 videoComposer：取消立即中断 TTS 请求、ffmpeg 进程和模型就绪等待
- **原声保留**：合成默认保留原视频音轨（35% 音量）并与配音混音，视频不会变成纯配音无声；无原声的视频自动降级为仅配音轨
- **编码提速**：合成默认走硬件编码器（macOS `h264_videotoolbox` / NVIDIA `h264_nvenc` / Intel `h264_qsv`，首次探测并缓存），无硬件回退 `libx264 faster/crf22`；关闭字幕烧录的任务视频轨直接 `-c:v copy` 跳过整段重编码
- **TTS 并发**：语音克隆模式下 TTS 句子并发生成（默认 2 并发，`gpuMode=cpu` 或 macOS MPS 时强制 1，仅 CUDA 并行），输出按字幕顺序排列。后端推理由 `_infer_lock` 串行化：MPS 上并发推理会损坏 MetalShaderLibrary hash table → SIGSEGV 崩溃
- **内置 Azure 音色**：`azureTts.js` 提供内置 Azure TTS V1 音色列表（`azure:` 前缀），合成用 `msedge-tts`（npm 包，纯 Node 实现，无需 Python/模型环境，联网调用微软 Edge TTS 服务）。未安装语音克隆环境/模型时也可直接使用；网络不可用时合成会失败并提示检查网络。Azure 模式 TTS 句子 2 并发生成，每次失败自动重试 3 次
- **语音驱动时间轴微调**（2026-08，`videoComposer.js` 内 `adjustTimelineToVoice`）：TTS 合成后逐句 ffprobe 实测时长 ÷ 用户语速 = 播放时长，重建字幕窗口。保留 LLM 首句锚点与句间 gap 节奏，仅用语音实际时长替换 LLM 估算窗口。总时长超视频时等比压缩 gap 与窗口。字幕烧录与语音 adelay 统一用微调后时间轴，三种 TTS 模式（voice_clone/azure/system）均受益。不改变语音速度。
