# autoDubServer (server.mjs) — 视频合成引擎

> 路径：`vendors/auto_dub_web/server.mjs`

## 职责

Node.js HTTP 服务，接收视频+SRT，完成 TTS 合成 + 字幕烧录 + 音频混合，输出最终视频。

## 核心端点

| 端点 | 说明 |
|------|------|
| `POST /api/process` | 主合成接口（视频+SRT → 输出视频） |
| `GET /api/health` | 健康检查 |
| `GET /outputs/<file>` | 浏览器调试用输出访问；Electron 复制输出后会删除对应临时文件 |

## 合成流程

1. 接收 multipart form（video_file + srt_file + 参数）
2. 解析 SRT 为字幕条目
3. 根据 tts_mode 选择 TTS 方式：
   - `system` — 系统 TTS
   - `voice_clone` — voicebox 克隆音色
4. ffmpeg 合成：
   - 原视频保持原始分辨率（不强制竖屏）
   - 字幕烧录（drawtext 或 subtitles filter）
   - 原声 70% + TTS 音频混合
5. 输出到 `outputs/` 目录，返回给 Electron 复制
6. `finally` 删除本次 job workspace；服务启动时删除上次崩溃残留的 `workspace/` 和 `outputs/`

## 关键参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `tts_mode` | system | TTS 模式 |
| `clone_profile_id` | '' | voicebox 音色 ID |
| `subtitle_enabled` | on | 字幕开关 |
| `voiceover_enabled` | on | 旁白开关 |
| `keep_original_audio` | on | 保留原声 |
| `original_audio_level` | 45 | 厏声音量（%） |
| `dub_audio_level` | 180 | 配音音量（%） |
| `subtitle_text_color` | #FFA100 | 字幕颜色 |
| `subtitle_stroke_color` | #000000 | 描边颜色 |

## 视频处理

**原比例输出**（已去掉强制竖屏）：
```js
[0:v]null[vbase]  // 直接通过，不缩放不裁切
```

## Voicebox 生成

剪辑配音使用 `/generate/stream` 获取 WAV 字节，不再调用持久化的 `/generate`。请求仍保留 `x_vector_only_mode: true`，避免参考录音内容泄漏到生成语音。模型下载/就绪检查在发起 streaming 请求前完成。

## 已废弃方案

- ~~强制 1080×1920 竖屏 + 模糊背景~~ → 用户要求原比例输出
- ~~/generate + /audio/{id}~~ → 会在 `voicebox-data/generations` 留下剪辑过程 WAV，改为 `/generate/stream`
