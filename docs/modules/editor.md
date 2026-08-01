# editor.js — 视频合成模块

> 路径：`src/main/services/editor.js`

## 职责

接收视频+SRT+设置，调用 videoComposer 完成 TTS 合成 + 字幕烧录 + 音频混合。

## 核心函数

### `editVideo(taskContext)`
参数：`{ task, settings, inputVideoPath, subtitlePath, outputPath, log, progress }`

**流程：**
1. 校验视频、字幕和输出路径
2. 如果需要配音克隆，确保 Voicebox 后端运行（通过 autoDubClient）
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
- 调用 `autoDubClient.ensureVoiceCloneBackend()` 确保 Voicebox 运行

## 注意事项

- `voiceoverEnabled=false` 时不会调用 TTS
- `subtitleEnabled` 依赖 `voiceoverEnabled`（旁白关则字幕也关）
- 输出路径由调用方决定，不在此模块创建目录
