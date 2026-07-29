# AntBot / 搬运蚁

AntBot 是一个 Electron 桌面工作台，用来把视频下载、字幕生成、二创剪辑、配音、发布整合到一条可批量执行的流水线里。

支持 macOS（Apple Silicon）和 Windows（x64）。

## 核心能力

- **视频下载**：支持 YouTube、抖音、B站、TikTok，自动探测 yt-dlp
- **AI 字幕生成**：接入 Gemini API 进行视频识别和字幕生成
- **智能剪辑**：内置 auto_dub_web 引擎，自动抽帧、识别、配音、合成
- **语音克隆**：内置 Voicebox 后端（Qwen3-TTS），支持上传样本克隆音色
- **GPU 加速**：Windows 支持 NVIDIA CUDA 加速语音合成
- **批量发布**：自动发布到视频号、抖音，支持定时发布
- **远程控制**：通过手机浏览器远程操控主控任务
- **多用户隔离**：登录态、设置、历史记录按用户分开保存
- **浏览器插件**：Chrome 插件配合桥接服务，实现页面操作自动化

## 适用场景

- 在一台桌面机上批量处理短视频任务
- 把下载、字幕、配音、发布流程固定成标准流水线
- 在局域网或 NAS 环境里远程控制桌面端执行任务

## 快速开始

### 环境要求

- Node.js 20+
- macOS (arm64) 或 Windows (x64)
- 首次安装需要联网下载 Playwright Chromium

### 本地运行

```bash
npm install
npm run dev
```

### 首次使用建议

1. 打开"设置"页面，填写 AI API Key 并获取模型
2. 登录视频号和抖音
3. 在"安装依赖"区域安装所需工具（yt-dlp、ffmpeg 等）
4. 如需语音克隆，在"字幕与音色"页面克隆音色
5. 回到主界面输入任务并启动

## 工作流

1. 输入任务（支持批量，一行一个）
2. 启动检查确认登录状态
3. 每条任务依次执行：下载 → 字幕生成 → 剪辑配音 → 发布
4. 输出文件、运行日志、发布记录保存到本地数据目录

## 任务输入格式

一行一个任务，字段用中英文逗号分隔。

```text
3月6日7时36分，小兵冲冲冲，微信，https://youtu.be/Q9KWcWKo2T8，0:49-22:12
原创，https://youtu.be/xxxx
```

平台判定：
- 包含"微信"或"视频号" → 视频号
- 包含"抖音" → 抖音
- 同时包含 → 双平台发布

## 语音克隆

- 在"字幕与音色"页面上传样本音频和参考文本
- 首次运行会自动安装 Voicebox 后端依赖
- 支持预置音色一键下载
- Windows 支持 NVIDIA GPU 加速（需安装 CUDA PyTorch）
- 生成的音色可直接用于剪辑配音

## 构建与打包

```bash
npm run build:mac          # macOS .app
npm run build:win          # Windows NSIS 安装包
npm run build:win:portable # Windows 便携版
```

产物默认输出到 `release/`。

## 远程控制

内置远程控制页面，支持通过手机浏览器查看状态、提交任务、查看日志。

- 自动启动 Cloudflare Tunnel 提供公网访问
- 支持密码保护和设备命名

## 数据目录

所有用户数据保存在 `~/AntBot/`：

```
~/AntBot/
├── logs/           # 运行日志
├── voicebox-env/   # 语音克隆 Python 环境
├── voicebox-data/  # 语音模型和音色数据
├── thumbnails/     # 视频缩略图
├── browser-plugin/ # 浏览器插件
└── local-server/   # 桥接服务（Windows）
```

## 仓库结构

```
src/main/                 Electron 主进程
src/renderer/             桌面端 UI
vendors/auto_dub_web/     剪辑配音引擎 + Voicebox 后端
docs/                     项目文档
scripts/                  打包和环境准备脚本
```
