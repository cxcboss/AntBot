# autoDubClient.js — voicebox TTS 后端管理与语音克隆

> 路径：`src/main/services/autoDubClient.js`（~1500 行，最大的模块）

## 职责

管理 voicebox TTS 后端（Python，端口 17493）的完整生命周期：启动、依赖安装、健康检查、就绪等待、关闭；并负责语音克隆档案的创建与解析。**不再负责视频合成**（合成已由 `editor.js → videoComposer.js` 直连 ffmpeg 完成）。

## 核心函数

| 函数 | 说明 |
|------|------|
| `ensureVoiceCloneBackend(projectPath, logger, progress, options)` | 确保 voicebox 后端运行：检测/安装依赖/启动/等待就绪 |
| `fetchVoiceCloneStatus()` | 健康检查（必须 `model_loaded` 才认为就绪） |
| `waitForVoiceCloneReady(timeoutMs)` | 循环等待后端真正就绪（默认 60 秒） |
| `getVoiceCloneProfiles()` | 读取音色档案列表 |
| `resolveVoiceCloneProfile({...})` | 解析音色 profile ID（发现 WAV 存在但未注册时自动注册） |
| `createVoiceCloneProfileWithAutoDub({...})` | 创建语音克隆档案（30 秒裁剪、重名加后缀） |
| `buildUniqueProfileName(baseName, existingNames)` | 重名时生成唯一档案名 |
| `resolveAutoDubProjectPath()` | 找到 auto_dub_web 项目路径 |
| `getManagedChildren()` | 返回所有 spawned 子进程（用于 app 退出清理） |
| `shutdownVoicebox()` | 关闭 voicebox 后端（释放 ~37GB TTS 模型内存） |

## 数据路径

| 路径 | 说明 |
|------|------|
| `~/AntBot/voicebox-env/.venv-voicebox/` | Python venv（torch 等），`path.join(os.homedir(), 'AntBot')` |
| `~/AntBot/voicebox-data/` | voicebox 后端数据（voicebox.db + models + profiles） |
| `auto_dub_web/vendor/voicebox/` | voicebox 源码 |
| `~/AntBot/voices.json` | 音色列表（与 voicebox 后端同步验证） |

## 关键端口

- voicebox: `127.0.0.1:17493`

## 语音克隆流程

1. `voice:clone` IPC → `runVoiceClone()`（voiceClone.js）
2. 上传参考音频（≤30 秒）→ `createVoiceCloneProfileWithAutoDub()`
3. FormData multipart 手动构建（`constructor?.name === 'FormData'` 检测）
4. 重名自动加后缀；`librosa` 缺失错误有专门修复逻辑
5. 完成后档案注册到 voicebox.db + voices.json

## 生命周期约束

- **合成完成后必须调用 `shutdownVoicebox()`**（成功或失败），否则 TTS 模型占用 ~37GB 内存不释放
- 连续任务场景：`editScheduler` 的 `_maybeShutdownVoicebox()` 延迟 60 秒关闭
- voicebox 崩溃后重启必须 `waitForVoiceCloneReady()` 确认模型加载完成再重试

## 平台注意

- Windows：`cwd` 必须是 `vendor/voicebox/`（`backend` 模块所在目录）
- `spawn()` 全部加 `windowsHide: true`
- Python 二进制平台感知：`process.platform === 'win32' ? 'python' : 'python3'`

## 已废弃方案

- ~~视频合成 HTTP POST `/api/process`（auto_dub_web Node 服务）~~ → 合成改走 `editor.js → videoComposer.js` 直连 ffmpeg
- ~~voicebox 数据目录在 Electron userData~~ → 统一到 `~/AntBot/voicebox-data/`
- ~~直接用 bash 脚本安装依赖~~ → 改用 `dependencyInstaller.js` 逐包安装
- ~~voicebox MPS GPU 加速~~ → PyTorch MPS 不稳定，设 `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0` 缓解
