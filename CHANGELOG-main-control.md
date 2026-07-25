# 开发记录 — 主控自动化流水线

## 2026-07-25: 主控功能实现

### 功能概述

主控页面自动化流水线：输入文本 → 并行下载视频 → 串行剪辑 → 发布。

### 核心改动

**只改了两个文件：**
- `src/main/taskRunner.js` — 并行下载 + 主控路径 + 缓存清理
- `src/main/services/fileUtil.js` — 导出 `buildPreciseTimestamp`

### 流水线架构

```
用户输入: "3月8日9时40分，原创，https://youtube.com/shorts/xxx"
  ↓ parser.js 解析
  ↓ { publishAt, isOriginal, videoUrl, taskName }
  ↓
Phase 1: 并行下载 (Promise.allSettled)
  ├─ 任务1 下载 → {outputBaseDir}/主控缓存/{baseName}.mp4
  ├─ 任务2 下载 → ...
  └─ 任务N 下载 → ...
  ↓ 全部完成
Phase 2: 串行处理 (逐个执行)
  ├─ subtitle: AI 生成字幕
  ├─ edit: 合成视频 (风格/音色/字幕/语速)
  └─ publish: 发布 (平台/原创/定时/文案/话题)
  ↓
输出: {outputBaseDir}/主控输出/{YYYYMMDD}/{videoName}_{timestamp}.mp4
  ↓
缓存清理: 删除主控缓存中的下载文件和中间产物
```

### 路径规范

| 路径 | 用途 |
|------|------|
| `{outputBaseDir}/主控缓存/` | 下载视频、字幕、帧提取等临时文件 |
| `{outputBaseDir}/主控输出/{YYYYMMDD}/` | 剪辑完成的最终视频 |

### 设置传递

芯片设置 → settings → 流水线各步骤：
- 风格: `S.editDefaults.style`
- 音色: `settings.voiceClone.voiceId/profileName`
- 字幕: `settings.style.subtitleEnabled/subtitleTextColor/...`
- 旁白: `settings.style.voiceoverEnabled`
- 语速: `settings.style.voiceSpeed`
- 重试: `settings.retry.failedTaskRetries`
- 自动发布: `settings.publish.enabled`
- 原创: `task.isOriginal` (parser 自动解析 "原创"/"不原创")
- 定时: `task.publishAt` (parser 自动解析时间)

### 缓存清理时机

- 任务成功完成 → 清理下载文件、字幕、中间分轨
- 任务失败 → 清理该任务的所有临时文件
- 用户停止任务 → 清理相关缓存
