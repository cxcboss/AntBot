# azureTts.js — 内置 Azure TTS 音色模块

> 路径：`src/main/services/azureTts.js`

## 职责

提供内置 Azure TTS V1 音色（免语音克隆、免模型下载，联网即可使用），以及基于 `msedge-tts` 的逐句 TTS 合成。

## 关键常量与函数

- `AZURE_TTS_VOICES`：内置中文音色表（普通话 9 个 + 台湾 1 个 + 粤语 1 个），id 统一 `azure:<ShortName>` 前缀（如 `azure:zh-CN-XiaoxiaoNeural`）
- `isAzureVoiceId(voiceId)`：判断音色 id 是否内置 Azure 音色（以 `azure:` 开头）
- `azureVoiceShortName(voiceId)`：提取微软 ShortName（`azure:` 之后部分）
- `getAzureVoices()`：返回内置音色数组，每个带 `source: 'azure'` 标记
- `synthesizeWithAzure(clips, voiceId, ttsDir, options)`：逐句合成
  - clips: `[{ startMs, text }]`
  - 2 并发，输出 `line_00001.mp3 ...`，返回 `[{ startMs, filePath }]`
  - 每句最多重试 3 次（网络不稳时 1s/2s 间隔）
  - 网络错误（连接失败/超时/断连）统一转成「无法连接微软语音服务，请检查网络」

## 依赖

- `msedge-tts`（npm 包，纯 Node 实现 Edge TTS，无 Python/模型依赖）
- 需要网络访问微软语音服务；国内网络不稳定时可能需代理

## 对接关系

- `ipc/library.js` `voices:list` 合并内置音色返回（`source: 'azure'`），`voices:save` 过滤掉 `azure:` 前缀只写克隆音色
- `editor.js` 判断 `voiceClone.voiceId` 为 `azure:` 前缀 → `ttsMode='azure'`，不启动 voicebox
- `videoComposer.js` `ttsMode='azure'` 分支调用 `synthesizeWithAzure`

## 注意事项

- 内置音色不可重命名/删除（renderer 对 `source: 'azure'` 隐藏操作按钮）
- 不需要语音克隆环境/模型，也不检查 voicebox 后端
