# CHANGELOG

AntBot（搬运蚁）开发记录。按时间线汇总，最新在上。

---

## 2026-07-26 发布功能修复 + UI 优化

**来源**：`CHANGELOG-publish-fix.md`

### 发布功能修复

**问题：** 主控流水线发布步骤卡住，浏览器插件不执行命令。

**根因：** Chrome MV3 的 Service Worker 被自动终止（30秒无活动），导致 `setInterval` 轮询中断。插件 UI 显示"已连接"但实际未在轮询。

**修复方案：**
- **插件 v0.0.4**：端口保活（25秒自连）+ `chrome.alarms` 兜底（1分钟唤醒）
- **App**：移除 `extensionConnected` 检查，只检查桥接端口就绪即发送命令
- 发布超时从 30 分钟改为 60 秒

**验证：** 四个平台（YouTube/抖音/TikTok/B站）均可正常下载+剪辑+发布。

### UI 优化

| 改动 | 说明 |
|------|------|
| 任务卡片加宽 | max-width: 620px |
| 时间显示优化 | 当天只显示时间，昨天显示"昨天 HH:MM"，更早显示日期，跨年显示年份 |
| 完成卡片操作 | 显示"打开目录"按钮（revealInFolder） |
| 进度条条件显示 | 完成/失败/停止状态不显示进度条 |
| 定时标签 | 去掉背景框和主题色，改为普通灰色文字 |
| 原创标签 | 保留药丸样式（.task-tag-accent） |
| 显示原文+复制 | 展开原文后出现"复制"按钮，点击复制到剪贴板 |
| 失败任务重试 | 新增"重试"按钮，重新提交为新任务排到队尾 |

**文件变更：** `publisher.js`（超时60秒）、`taskRunner.js`（移除extensionConnected检查）、`app.js`、`style.css`、插件 `manifest.json`（v0.0.4 + alarms 权限）、`background.js`（端口保活 + alarms 兜底）。

---

## 2026-07-25 下载功能实现 + YouTube 不可播放修复

**来源**：`CHANGELOG-download.md`

### 功能概述

在侧边栏新增「下载」功能，支持 YouTube、抖音、TikTok、B站视频下载。

**技术方案：** yt-dlp（brew 安装，版本 2026.07.04）+ ffmpeg；Cookies 用 Playwright 后台获取 + Electron BrowserWindow 登录。

### 各平台下载策略

| 平台 | 格式选择 | Cookies | 特殊参数 |
|------|---------|---------|---------|
| YouTube | `bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]` 优先 H.264+AAC | 用户通过 Electron BrowserWindow 登录后提取，保存到 `~/AntBot/cookies/youtube.txt` | `--remote-components ejs:github` |
| 抖音 | `bestvideo+bestaudio/best` | Playwright 后台访问 douyin.com 获取，保存到 `~/AntBot/cookies/douyin.txt`，24小时缓存 | 无 |
| TikTok | `bestvideo+bestaudio/best` | 不需要 | 无 |
| B站 | `bestvideo+bestaudio/best` | 不需要 | 无 |

### YouTube 不可播放问题

**原因：** YouTube 默认下载 AV1 视频 + Opus 音频，macOS QuickTime 等播放器不兼容。

**修复：** 格式选择优先 H.264 (`vcodec^=avc1`) + AAC (`acodec^=mp4a`)，降级到 AV1+bestaudio，最终 fallback 到 best。`ffprobe` 验证输出为 `Video: h264 (High)` + `Audio: aac (LC)`。

### 命名规则

`{平台前缀}_{月日}_{时分秒毫秒}.mp4`（yt/dy/tk/b + `_725_143025_001.mp4`）。

### UI 设计

- 卡片布局：类聊天消息，平台标签 + 文件名 + 状态 / 原链接（横向滚动）/ 时间
- 等待动画：「准备.」「准备..」「准备...」循环，400ms 间隔
- 下载中：数字百分比 + 速度（无进度条）
- 多选：Shift+点击多选，底部「全选」「清理选中」按钮
- 右键菜单：重试/取消/打开文件/删除文件/清理记录
- YouTube 登录提示：首次打开（无 cookies 时）显示，可跳过
- 排序：最旧在上，最新在下

**文件变更：** `downloadManager.js`（新建）、`ipc.js` +9 个 download:* handlers、`preload.js`、`index.html`、`style.css`、`app.js`。

**测试结果：** 四平台均可下载且可播放（H.264/H.265 + AAC）。

---

## 2026-07-25 UI 设计系统重构 + 音色/风格内置

**来源**：`CHANGELOG-2026-07-25.md`

### 一、UI 设计系统重构

基于 shadcn/ui 设计理念系统性重构：

- **设计 Token 系统**（新建 `design-tokens.css`）：主题色从橙色 `#D57E3C` 改为青色 Teal `#0D9488`（注：v0.6.7 又改为中性灰阶）；暗色模式从 `prefers-color-scheme` 媒体查询改为 class-based `.dark`；语义化变量 `--brand`→`--primary`、`--surface`→`--card` 等；新增 5 级阴影、6 级圆角、3 级过渡、4px 间距网格
- **图标系统迁移到 Lucide**（重写 `icons.js`）：49 个图标内联为 SVG 字符串
- **组件样式精修**（`style.css`）：按钮 32px 高 + focus ring；输入框统一样式；卡片阴影；对话框 blur + shadow-lg；Toast 320px
- **发布页响应式重构**：平台选择改双按钮、toggle 开关、文案话题上下全宽、定时选择器默认隐藏

### 二、内置风格（10 个）

内嵌到 `ipc.js` 的 `BUILTIN_STYLES`：电影解说、探店vlog、儿童游戏、儿童手工、生活日常、知识科普、搞笑段子、情感文案、美食制作、旅行记录。设置页新增「重新加载内置风格」按钮。

### 三、预置音色下载

- 使用 App 的 voicebox 后端批量克隆 10 个音色（TVB女生/乌萨奇/奶龙/小姐姐/懒羊羊/曼波/熊二/猪妞/蜡笔小新/解说小帅），音频格式 PCM 16-bit, mono, 24kHz, 30秒以内
- GitHub 仓库：https://github.com/cxcboss/antbot-voice-models （Release v1.0：10 个 zip + manifest.json，每个 zip 含 `ref.wav` + `meta.json`）
- App 内「字幕与音色」页新增「预置音色」区域，从 GitHub 获取 manifest 展示列表；新增 IPC `voice:download-preset`

### 四、API 额度显示优化

- "可剪辑时长"数字颜色改为默认前景色
- 侧边栏 key 显示从次数改为 `X小时X分`（时间）
- 每次 AI 调用（成功/失败/限频）都正确记录，持久化到 `api-usage.json`，按天自动重置

### 五、批量克隆脚本

- `scripts/batch-clone.mjs`：独立 Node.js 脚本，通过 voicebox HTTP API 批量克隆
- `scripts/batch-clone-voices.mjs`：通过 Electron IPC 克隆（需 App 运行）

### 已知问题与后续

- `default-styles.json` 因 JSON 引号问题无法解析，改用 JS 内嵌方案
- 预置音色依赖 GitHub 网络访问，离线环境无法下载
- 批量克隆脚本需要 voicebox 后端环境（Python venv + CosyVoice 模型）

---

## 2026-07-25 主控自动化流水线

**来源**：`CHANGELOG-main-control.md`

### 功能概述

主控页面自动化流水线：输入文本 → 并行下载视频 → 串行剪辑 → 发布。

**核心改动（只改两个文件）：** `src/main/taskRunner.js`（并行下载 + 主控路径 + 缓存清理）、`src/main/services/fileUtil.js`（导出 `buildPreciseTimestamp`）。

### 流水线架构

```
用户输入: "3月8日9时40分，原创，https://youtube.com/shorts/xxx"
  ↓ parser.js 解析 → { publishAt, isOriginal, videoUrl, taskName }
Phase 1: 并行下载 (Promise.allSettled) → {outputBaseDir}/主控缓存/{baseName}.mp4
Phase 2: 串行处理 (逐个执行)
  ├─ subtitle: AI 生成字幕
  ├─ edit: 合成视频 (风格/音色/字幕/语速)
  └─ publish: 发布 (平台/原创/定时/文案/话题)
输出: {outputBaseDir}/主控输出/{YYYYMMDD}/{videoName}_{timestamp}.mp4
缓存清理: 删除主控缓存中的下载文件和中间产物
```

### 路径规范与设置传递

| 路径 | 用途 |
|------|------|
| `{outputBaseDir}/主控缓存/` | 下载视频、字幕、帧提取等临时文件 |
| `{outputBaseDir}/主控输出/{YYYYMMDD}/` | 剪辑完成的最终视频 |

设置传递：风格 `S.editDefaults.style`、音色 `settings.voiceClone.voiceId/profileName`、字幕/旁白/语速 `settings.style.*`、重试 `settings.retry.failedTaskRetries`、自动发布 `settings.publish.enabled`、原创/定时由 parser 自动解析。

**缓存清理时机：** 任务成功完成 / 任务失败 / 用户停止任务 → 清理该任务所有临时文件。

---

## 2026-07-24 发布功能对接（浏览器插件桥接）

**来源**：`DEV_PUBLISH.md`

### 功能概述

将外部仓库 `video-publish-extension` 对接进 App：在发布页选择视频 → 通过默认浏览器中的 Chrome 插件自动发布到抖音/视频号。

### 架构

```
蚁 app 发布页 (Electron)
    ↓ IPC (publish:start)
蚁 app 主进程 (ipc.js → browserPublishBridge.js)
    ↓ HTTP POST /api/bridge/commands
搬运蚁发布助手桥接服务 (local-server/server.js, port 18321)
    ↓ 轮询 GET /api/bridge/commands/next
Chrome 插件 background.js (800ms 轮询)
    ↓ chrome.tabs.sendMessage
Chrome 插件 content scripts (douyin.js / weixin.js)
    ↓ 自动上传、填写表单、点击发布
    ↓ POST /api/bridge/commands/:id/result 回传结果
蚁 app 接收结果 → 渲染到发布页
```

### 主要改动

- **新增**：`src/main/services/bridgeQueue.js`（命令队列）、`browserPublishBridge.js`（桥接客户端）、`tests/browserPublishBridge.test.js`
- **修改**：`ipc.js`（publish:bridge-status / bridge-capabilities / start / stop）、`preload.js`、`config.js`（publish.browserExtension）、`publisher.js`（优先走桥接，失败回退 Playwright）、发布页 UI
- **插件改名**："AI 视频发布助手" → "搬运蚁发布助手"
- **桥接服务端点**：`/api/bridge/status`、`/api/bridge/capabilities`、`/api/bridge/commands`（POST）、`/api/bridge/commands/next`、`/:id`、`/:id/events`、`/:id/result`、`/:id/cancel`

### 支持的桥接命令

`publish.start` / `publish.stop` / `publish.getState`、`browser.getState` / `getTabs` / `navigate` / `click` / `type` / `select` / `scroll` / `screenshot` / `eval`。

### 使用流程

1. Chrome 安装插件：`publish-extension/chrome-extension/`
2. 蚁 app 打开 → 点击"发布" → 选视频 → 选平台 → 点"通过浏览器发布"
3. 插件自动打开发布页 → 上传视频 → 填表单 → 点发布 → 回传结果

### 注意事项

- 插件 content scripts 固定请求 `http://localhost:18321` 获取视频文件
- 发布页不依赖登录状态，但实际发布需要在 Chrome 中登录抖音/视频号

---

## 2026-07-23 重大功能更新与优化

**来源**：`DEV_LOG.md`

### Phase 1: 减少人机感

- **Prompt 优化**：system/user 消息分离；do/don't 结构；角色命名强化；互动元素频率（30秒以下≥1次，30-60秒≥2次，60秒以上≥3次）
- **动态间隔**：感叹句后 600ms、问句后 350ms、叙述继续 80ms、话题转换 450ms、插入语 150ms
- **自然时长计算**：标点影响时长（逗号+200ms，句号+400ms，省略号+600ms）、数字 +150ms/组、句子类型乘数（感叹70%、问句120%、戏剧性130%）

### Phase 2: 并行处理加速

- 并行帧识别：并发批次 3 个（原串行）、每批 6 帧（原4帧），预期提速 50-70%
- SRT + 命名并行：`Promise.all` 并行执行，提速 2-5秒/视频
- 识别结果缓存：最多 50 条，键 = 视频路径 + 帧数 + 首帧文件大小
- Voicebox 预热：延迟 60 秒关闭（原立即关闭），连续任务无需重启
- 自动帧率选项：支持 'auto'，按视频宽度动态调整

### Phase 3: 用户体验优化

- ETA 显示（准备 0-50%、合成 55-100%，格式"预计X分X秒"）
- 批量操作（复选框 + 批量开始/取消/移除）
- 错误详情展开（失败任务显示 50 字摘要，点击展开完整信息）
- 设置持久化（风格/音色/字幕默认值保存到 localStorage）

### UI 和字幕优化

- **视频预览图**：ffmpeg 截取第1秒帧转 base64；MD5 哈希文件名缓存到 `~/AntBot/thumbnails/`
- **完成状态颜色**：绿色背景 → 白色背景
- **完成后禁用设置**：完成/合成中的任务禁用风格/音色/字幕按钮
- **字幕单行显示**：ASS `WrapStyle=2`、drawtext 去换行符、`cleanSubtitleText` 移除换行
- **字幕标点规则**：去末尾句号、保留感叹号/问号、规范省略号、英文标点转中文
- **动态字幕字号**：360p→22px … 4K→48px（最小 18px，每行 8-30 字）
- **结尾语音缓冲**：最后一句字幕每字至少 300ms、最少 2 秒，防止语音截断
- **任务队列排版优化**：整体紧凑约 25%

### 问题修复汇总

- 严重：合成取消不停止 ffmpeg（加 abortSignal 传递）、识别缓存键冲突、批量处理错误被吞没
- 中等：字幕样式未传递、ETA 完成时未清除、强制拆分未应用
- 低：毫秒解析 padEnd→padStart、ETA 进度 52→50、移除死代码 smartEdit、音速滑块 0.5x-2.0x、音色/字幕默认值持久化、右键删除移除

**测试：** 后端核心 192/192、前端 UI 14/14、内存资源 8/8、完整流程 10/10、边界 25+ 场景，总计 224+ 测试通过。

---

## 2026-07-21 剪辑缓存清理与语音生成修复

**来源**：`DEV_LOG.md`

### 背景

用户反馈多个剪辑视频会重复同一句参考语音。检查发现旧剪辑流程通过 Voicebox `/generate` 生成了大量持久化历史 WAV，失败/取消/中断后没有统一清理中间文件。

### 根因

- 剪辑 TTS 使用 `/generate` + `/audio/{id}`，在 `~/AntBot/voicebox-data/generations` 写入历史 WAV
- 智能剪辑准备阶段使用系统临时目录 `antbot-smart-edit-*`，只有部分取消路径会清理
- `auto_dub_web/workspace` 和 `outputs` 缺少完整清理
- App 启动恢复只重置任务状态，没有按任务归属回收残留缓存

### 代码变更

- 新增 `clipArtifacts.js`，统一管理 `~/AntBot/clip-cache/<task-id>`，只删除应用明确拥有的剪辑缓存
- `smartEditor.js` 改为按任务写入 clip-cache；成功生成 SRT 后立即删除抽帧图
- `editScheduler.js` 在失败、取消、移除、退出和启动恢复时清理缓存；中断任务重置为 pending
- `auto_dub_web` 启动时清理旧 workspace/outputs；单个 job 在 finally 删除 workspace
- `autoDubClient.js` 复制最终输出后删除临时输出副本
- voicebox 改用 `/generate/stream`，保留 `x_vector_only_mode: true`，避免继续产生 history WAV

### 数据清理

- 删除 261 条剪辑生成记录 + 261 个 WAV（约 145 MB）
- 删除 1 个 0 字节临时 store 文件
- 未删除：models、profiles、venv、App 设置、音色档案、最终输出视频

---

## 2026-07-21 SRT 时间线被朗读与烧录修复

**来源**：`DEV_LOG.md`

### 故障

字幕生成后只有 `1 句`，成品把后续字幕序号、时间线和正文全部作为第一句字幕烧录，Voicebox 也朗读了这些时间线。

### 根因与修复

- 原 `parseSrt()` 只按空行切分字幕块；AI 返回连续 SRT、没有空行时整份字幕落入第一条
- 改为逐行识别字幕序号、时间线和正文，不依赖空行分块
- 兼容 `-->`、`->`、`→` 箭头，逗号或句点形式的 1-3 位毫秒
- 无法可靠解析的行直接报错停止任务，禁止污染字幕/配音
- 首次无有效 SRT 时自动请求一次严格格式修复；第二次结果仍须通过安全解析
- macOS 构建改为只输出 `.app`，不再生成 DMG

---

## 2026-07-21 Vision 图片批次 400 修复

**来源**：`DEV_LOG.md`

### 故障

剪辑任务在 AI 识别阶段失败：`Image count 5 exceeds limit 4 per request.`

### 根因与修复

- `smartEditor.js` 将抽帧图片按每批 5 张发送，超过上游接口每请求最多 4 张的限制
- 新增统一 Vision 分批函数，每请求最多 4 张图，保持全部帧顺序和完整性
- 新增 25 帧回归测试，验证分组 `4/4/4/4/4/4/1` 不漏帧不乱序
