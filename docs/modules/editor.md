# editor.js — 视频合成模块

> 路径：`src/main/services/editor.js`

## 职责

接收视频+SRT+设置，调用 auto_dub_web 完成 TTS 合成 + 字幕烧录 + 音频混合。

## 核心函数

### `editVideo(taskContext)`
参数：`{ task, settings, inputVideoPath, subtitlePath, outputPath, log }`

**流程：**
1. 如果配置了自定义剪辑命令 → 执行命令
2. 否则找到 auto_dub_web → 调用 `processWithAutoDub()`
3. 都没有 → 直接复制视频（占位模式）

**settings 结构：**
```js
{
  style: { voiceoverEnabled, subtitleEnabled, voiceSpeed, subtitleTextColor, subtitleStrokeColor, subtitlePositionPercent },
  voiceClone: { voiceId, profileName, samplePath, referenceText, language },
  paths: { editProjectPath },
  commands: { edit }
}
```

## 对接关系

- 被 `smartEditor.composeEditVideo()` 调用
- 调用 `autoDubClient.processWithAutoDub()` 执行实际合成
- 调用 `commandRunner.runCommand()` 执行自定义命令

## 注意事项

- `voiceoverEnabled=false` 时不会调用 TTS
- `subtitleEnabled` 依赖 `voiceoverEnabled`（旁白关则字幕也关）
- 输出路径由调用方决定，不在此模块创建目录
