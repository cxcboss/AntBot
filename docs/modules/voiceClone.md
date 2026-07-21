# voiceClone.js — 语音克隆流程

> 路径：`src/main/services/voiceClone.js`

## 职责

语音克隆的入口流程：参数校验 → 启动服务 → 创建档案 → 保存结果。

## 流程

1. 校验样本音频和参考文本
2. `createVoiceCloneProfileWithAutoDub()` — 创建 voicebox 档案
3. 保存 `voiceId` 到 settings

## 调用链

```
ipc.js voice:clone handler
  → voiceClone.runVoiceClone()
    → autoDubClient.createVoiceCloneProfileWithAutoDub()
      → ensureAutoDubServer()
      → ensureVoiceCloneBackend()
      → createVoiceCloneProfileDirect() (voicebox /profiles API)
```

## 注意事项

- 样本音频上传前自动裁剪到 30 秒（voicebox 限制）
- 档案名重名时自动加后缀
- librosa 缺失时自动修复
