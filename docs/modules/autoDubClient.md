# autoDubClient.js — auto_dub_web 服务管理

> 路径：`src/main/services/autoDubClient.js`（~1900 行，最大的模块）

## 职责

管理 auto_dub_web Node.js 服务的启动/健康检查，管理 voicebox TTS 后端，执行视频合成请求。

## 核心函数

| 函数 | 说明 |
|------|------|
| `ensureAutoDubServer(projectPath)` | 确保 auto_dub_web 运行，启动/重启/健康检查 |
| `processWithAutoDub(params)` | 发送视频+SRT 到 auto_dub_web 合成 |
| `ensureVoiceCloneBackend(...)` | 确保 voicebox 后端运行，安装依赖 |
| `resolveVoiceCloneProfile(...)` | 解析音色 profile ID |
| `createVoiceCloneProfileWithAutoDub(...)` | 创建语音克隆档案 |
| `resolveAutoDubProjectPath()` | 找到 auto_dub_web 项目路径 |
| `getManagedChildren()` | 返回所有 spawned 子进程（用于 app 退出清理） |

## 数据路径

| 路径 | 说明 |
|------|------|
| `~/AntBot/voicebox-env/.venv-voicebox/` | Python venv（torch 等） |
| `~/AntBot/voicebox-data/` | voicebox 后端数据（voicebox.db + models） |
| `auto_dub_web/vendor/voicebox/` | voicebox 源码 |

## 关键端口

- auto_dub_web: `127.0.0.1:5001`
- voicebox: `127.0.0.1:17493`

## processWithAutoDub 合成流程

1. `ensureAutoDubServer()` — 启动 auto_dub_web
2. `resolveVoiceCloneProfile()` — 找到音色 profile
3. 读取视频和 SRT 文件到内存
4. HTTP POST 到 `/api/process`（带重试 3 次）
5. auto_dub_web 内部：TTS → 字幕烧录 → 音频混合 → 输出
6. 复制 `auto_dub_web/outputs/<name>` 到最终输出路径后，删除 auto_dub 的临时输出副本

## 已废弃方案

- ~~voicebox 数据目录在 Electron userData~~ → 统一到 `~/AntBot/voicebox-data/`
- ~~直接用 bash 脚本安装依赖~~ → 改用 `dependencyInstaller.js` 逐包安装
- ~~voicebox MPS GPU 加速~~ → PyTorch MPS 不稳定，设 `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0` 缓解

## 清理约束

- `processWithAutoDub()` 只删除 auto_dub 自己返回的临时输出副本
- 最终输出路径由调度器生成并保留
- Voicebox 后端在合成完成或调度器无活跃任务时关闭，以释放模型内存
