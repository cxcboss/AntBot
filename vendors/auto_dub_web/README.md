# 自动剪辑配音字幕工具（Web UI）

本地网页工具，支持：
- 上传视频 + `.srt` 字幕
- 自动转成抖音竖屏 `9:16`（`1080x1920`）
- 原视频居中显示，不拉伸
- 空白区域使用视频模糊背景填充
- 按字幕时间线配音并混音（保留原声）
- 输出带字幕和配音的 MP4

## 配音来源
- 系统 TTS（macOS `say`）
- 外部配音音频（例如剪映导出）
- Voice Clone（参考 voicebox 的语音克隆流程）

## 环境要求
- Node.js 18+（推荐 22+）
- ffmpeg / ffprobe
- macOS（仅系统 TTS 需要 `say`）

## 启动 Web 工具
```bash
cd /Users/chenxincheng/Downloads/auto_dub_web
node server.mjs
```

浏览器打开：
- [http://127.0.0.1:5001](http://127.0.0.1:5001)

## Voice Clone（voicebox 参考实现）
项目已内置 voice clone API 接入，首次使用先安装后端依赖：

```bash
cd /Users/chenxincheng/Downloads/auto_dub_web
./scripts/setup_voicebox_backend.sh
./scripts/start_voicebox_backend.sh
```

然后在页面中：
1. 上传样本音频 + 参考文本，创建克隆档案
2. 在“配音来源”里选“语音克隆档案”
3. 处理视频时会按字幕逐句生成克隆语音并按时间线对齐

## 使用步骤
1. 上传视频文件（mp4/mov/mkv/avi/webm/m4v）
2. 上传 `.srt` 字幕文件
3. 选择配音来源：
   - 上传“外部配音文件”时，优先使用外部音频
   - 不上传外部音频时，可用系统 TTS 或 Voice Clone
4. 设置配音速度（`0.5 ~ 3.0`）与语速（系统 TTS `80 ~ 600`）
5. 选择字幕位置（顶部/中间/底部）和字幕边距
6. 选择是否保留原声，调节原声/配音音量
7. 点击“开始生成”

## 输出目录
- 成品视频：`/Users/chenxincheng/Downloads/auto_dub_web/outputs`
- 中间文件：`/Users/chenxincheng/Downloads/auto_dub_web/workspace`

## 说明
- 字幕会优先尝试硬字幕；如果当前 ffmpeg 不支持对应滤镜，会自动切换为软字幕轨并生成 `.vtt` 供网页预览。
- 硬字幕默认样式：黄色文字 + 白色描边。
- 字幕文本会先按句号/问号/感叹号等标点拆句，再逐句配音并对齐时间线。
- 默认保留原视频音轨，并与配音混音后导出。
