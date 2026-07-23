# AntBot 开发记录

> 最后更新：2026-07-23 | 版本：0.3.6 | 分支：main

## 项目概况

AntBot（搬运蚁）是 Electron 桌面应用，核心做视频自动化流水线：下载 → 字幕生成 → 剪辑配音 → 发布。

## 2026-07-21 剪辑缓存清理与语音生成修复

### 背景

用户反馈剪辑视频配音异常，多个剪辑视频会重复同一句参考语音。随后检查 `~/AntBot` 数据目录，发现旧剪辑流程通过 Voicebox `/generate` 生成了大量持久化历史 WAV，失败/取消/中断后也没有统一清理抽帧、字幕、TTS、合成中间文件。

### 根因

- 剪辑 TTS 使用 Voicebox `/generate` + `/audio/{id}`，会在 `~/AntBot/voicebox-data/generations` 写入历史记录和 WAV。
- 智能剪辑准备阶段使用系统临时目录 `antbot-smart-edit-*`，只有部分取消路径会清理。
- `auto_dub_web/workspace` 和 `auto_dub_web/outputs` 缺少成功/失败/启动时的完整清理。
- App 启动恢复只重置任务状态，没有按任务归属回收残留缓存。

### 代码变更

- 新增 `src/main/services/clipArtifacts.js`，统一管理 `~/AntBot/clip-cache/<task-id>`，只删除应用明确拥有的剪辑缓存。
- `smartEditor.js` 改为按任务写入 `clip-cache`；成功生成 SRT 后立即删除抽帧图，准备阶段异常会清理任务目录。
- `editScheduler.js` 在失败、取消、移除、退出和启动恢复时清理相关缓存；中断的 `preparing/composing` 任务重置为 `pending`。
- `vendors/auto_dub_web/server.mjs` 启动时清理旧 `workspace/outputs`；单个 job 在 `finally` 删除 workspace。
- `autoDubClient.js` 复制最终输出后删除 auto_dub 的临时输出副本，最终成片保留在用户输出目录。
- `voicebox-generation.mjs` 和 `server.mjs` 改用 `/generate/stream`，保留 `x_vector_only_mode: true`，避免继续产生 Voicebox history WAV。
- 合并 Claude 工作树中的最新智能剪辑 UI/调度/API 实现，同时保留当前分支的参考音频泄漏修复。

---

## 2026-07-23 重大功能更新与优化

### Phase 1: 减少人机感

#### 1.1 Prompt 优化
- **system/user 消息分离**：风格指令放 system，视频内容放 user，AI 更易遵循
- **do/don't 结构**：替代编号列表，更清晰
- **角色命名强化**：要求 AI 先列出角色名再生成文案，禁止使用"角色"、"玩家"、"它"等泛称
- **互动元素频率**：30秒以下至少1次，30-60秒至少2次，60秒以上至少3次

#### 1.2 动态间隔
- 感叹句后：600ms（让情绪落地）
- 问句后：350ms（给观众思考时间）
- 叙述继续：80ms（保持流畅）
- 话题转换：450ms（清晰分隔）
- 插入语：150ms（快速过渡）

#### 1.3 自然时长计算
- 标点符号影响时长（逗号+200ms，句号+400ms，省略号+600ms）
- 数字需要更多处理时间（+150ms/数字组）
- 句子类型乘数（感叹句70%，问句120%，戏剧性130%）

### Phase 2: 并行处理加速

#### 2.1 并行帧识别
- 并发批次：3个（原为串行）
- 每批帧数：6帧（原为4帧）
- 预期提升：50-70% 更快

#### 2.2 SRT + 命名并行
- 使用 `Promise.all` 并行执行字幕生成和视频命名
- 预期提升：2-5秒/视频

#### 2.3 识别结果缓存
- 缓存大小：最多50条
- 缓存键：视频路径 + 帧数 + 首帧文件大小
- 重试时即时返回，无需重新识别

#### 2.4 Voicebox 预热
- 延迟60秒关闭（原为立即关闭）
- 连续任务无需重启 voicebox

#### 2.5 自动帧率选项
- 支持 'auto' 选项
- 根据视频宽度动态调整帧率

### Phase 3: 用户体验优化

#### 3.1 ETA 显示
- 准备阶段：基于 0-50% 进度计算
- 合成阶段：基于 55-100% 进度计算
- 格式：预计X分X秒

#### 3.2 批量操作
- 复选框选择多个任务
- 批量开始/取消/移除选中任务
- 清除选择

#### 3.3 错误详情展开
- 失败任务显示错误摘要（50字）
- 点击展开完整错误信息

#### 3.4 设置持久化
- 风格/音色/字幕默认值保存到 localStorage
- 重启后恢复用户设置

### UI 和字幕优化

#### 视频预览图
- **问题**：预览图空白、破损
- **方案**：ffmpeg 截取视频第1秒帧，转为 base64 数据 URL
- **缓存**：MD5 哈希文件名，自动缓存到 `~/AntBot/thumbnails/`

#### 完成状态颜色
- **修改**：绿色背景 → 白色背景
- **原因**：绿色不好看

#### 完成后禁用设置
- **修改**：完成/合成中的任务禁用风格/音色/字幕按钮
- **原因**：已完成任务不应再修改设置

#### 字幕单行显示
- **ASS 字幕**：WrapStyle=2（禁止自动换行）
- **drawtext**：去除换行符，确保单行
- **cleanSubtitleText**：添加换行符移除逻辑

#### 字幕标点规则
- 去除末尾句号（。）— 字幕是片段不是句子
- 保留感叹号（！）和问号（？）— 表达情绪
- 规范省略号（…）
- 英文标点转中文

#### 动态字幕字号
| 分辨率 | 字号 | 每行字数 |
|--------|------|---------|
| 360p (640x360) | 22px | 23字 |
| 480p (854x480) | 24px | 28字 |
| 720p (1280x720) | 29px | 30字 |
| 1080p (1920x1080) | 38px | 30字 |
| 4K (3840x2160) | 48px | 30字 |

- 最小字号：18px（原12px）— 小视频文字更清晰
- 最大字号：48px
- 每行字数：8-30字

#### 结尾语音缓冲
- 最后一句字幕添加缓冲时间
- 每字至少300ms，最少2秒
- 防止语音被截断

#### 任务队列排版优化
- 卡片间距：8px → 6px
- 卡片内边距：12px → 8px/10px
- 图标大小：48px → 36px
- 进度条高度：6px → 3px
- 整体紧凑约25%

### 问题修复汇总

#### 严重问题（已修复）
1. 合成取消不停止 ffmpeg → 添加 abortSignal 传递
2. 识别缓存键冲突 → 使用路径+帧数+文件大小
3. 批量处理错误被吞没 → 收集错误并报告

#### 中等问题（已修复）
4. 字幕样式未传递 → 从设置读取字幕样式
5. ETA 完成时未清除 → 终态添加 t.eta=''
6. 强制拆分未应用 → 循环检查每个分段

#### 低优先级（已修复）
7. 毫秒解析错误 → padEnd→padStart
8. ETA 进度不匹配 → 52→50
9. 死代码 → 移除 smartEdit
10. 音速滑块范围 → 0.5x-2.0x
11. 音色/字幕默认值持久化 → 保存到 localStorage
12. 右键删除无效 → 移除右键菜单功能

### 测试验证

全面测试覆盖：
- 后端核心函数：192/192 PASS
- 前端 UI 组件：14/14 PASS
- 内存和资源：8/8 PASS
- 完整用户流程：10/10 PASS
- 边界情况：25+ 场景
- **总计：224+ 测试通过**

### 主要修改文件清单

| 文件 | 修改内容 |
|------|---------|
| `src/main/services/smartEditor.js` | 动态间隔、自然时长、内容截断、并行识别、缓存、字幕清理、字号计算 |
| `src/main/services/editScheduler.js` | ETA显示、Voicebox预热、字幕样式读取、任务更新 |
| `src/main/ipc.js` | 新增IPC处理器、缩略图提取 |
| `src/main/preload.js` | 新增API桥接 |
| `src/renderer/app.js` | 批量操作、错误展开、缩略图预览、设置持久化 |
| `src/renderer/style.css` | 紧凑排版、完成状态白色、禁用样式 |
| `vendors/auto_dub_web/server.mjs` | 动态字号、单行字幕、WrapStyle=2 |

### 数据清理

清理范围严格限制为剪辑过程垃圾：

- 通过 Voicebox history API 删除 261 条剪辑生成记录。
- `~/AntBot/voicebox-data/generations`：261 个 WAV，约 145 MB → 0 个 WAV，0B。
- 删除 1 个 0 字节临时 store 文件：`antbot-store.json.63744.1784531909843.tmp`。
- 未删除：`voicebox-data/models`、`voicebox-data/profiles`、`voicebox-env`、`models`、`browser-profiles`、App 设置、音色档案、最终输出视频。

### 验证

- `node --test src/main/services/tests/clipArtifacts.test.js vendors/auto_dub_web/tests/clip-workspace.test.mjs vendors/auto_dub_web/tests/voicebox-generation.test.mjs`
- `PYTHONPATH=vendors/auto_dub_web/vendor/voicebox /Users/chenxincheng/AntBot/voicebox-env/.venv-voicebox/bin/python -m unittest vendors.auto_dub_web.vendor.voicebox.backend.tests.test_reference_audio_leak`
- `node --check` 覆盖 `ipc.js`、`preload.js`、`renderer/app.js`、`editScheduler.js`、`smartEditor.js`、`autoDubClient.js`、`apiServer.js`、`server.mjs`
- `npm run build:mac`
- App 产物：`/Users/chenxincheng/Desktop/my/Develop/Claude/AntBot/搬运蚁.app`
- DMG 产物：`/Users/chenxincheng/Desktop/my/Develop/Claude/AntBot/release/搬运蚁-0.3.6-mac-arm64.dmg`

## 2026-07-21 SRT 时间线被朗读与烧录修复

### 故障

剪辑任务日志显示字幕生成后只有 `1 句`，成品把后续字幕序号、时间线和正文全部作为第一句字幕烧录，Voicebox 也朗读了这些时间线。

### 根因与修复

- 原 `parseSrt()` 只按空行切分字幕块；AI 返回连续 SRT、没有空行时，后续整份字幕会落入第一条字幕正文。
- 改为逐行识别字幕序号、时间线和正文，不再依赖空行分块。
- 兼容 AI 常见的 `-->`、`->`、`→` 箭头，以及逗号或句点形式的 1-3 位毫秒。
- 对带时间戳但无法可靠解析的行直接报错并停止任务，禁止继续烧录或配音污染文本。
- 首次 AI 响应没有有效 SRT 时，自动携带原始响应和视频识别内容请求一次严格格式修复；第二次结果仍须通过安全解析。
- macOS 构建改为只输出 `.app`，不再生成 DMG。

### 回归测试

- 连续 5 条标准 SRT 没有空行时，必须解析成 5 条独立字幕。
- 常见箭头和毫秒格式变体必须规范化为正确时间。
- 无法识别的时间线必须抛出格式错误，不能进入字幕正文。
- 首次返回纯文本时必须触发一次格式修复，并接受修复后的严格 SRT。

### 验证

- `node --test src/main/services/tests/*.test.js vendors/auto_dub_web/tests/*.test.mjs`：11 项通过。
- `node --check src/main/services/smartEditor.js` 与 `git diff --check` 通过。
- `npm run build:mac` 只执行 `electron-builder --mac dir`，成功生成 `.app`。
- `release/` 中不再生成 DMG、blockmap 或 `latest-mac.yml`。
- 使用 `23256.mp4`、风格“开车解说”、音色“猪妞”完成真实剪辑：生成 6 条独立字幕并成功输出成品。
- Voicebox 日志中的 6 条 TTS 输入均为纯字幕文案，无序号和时间线；抽查成品 6 个时间点，均只显示对应单句字幕。
- App 产物：`/Users/chenxincheng/Desktop/my/Develop/Claude/AntBot/搬运蚁.app`

## 2026-07-21 Vision 图片批次 400 修复

### 故障

剪辑任务 `23256.mp4` 在 AI 识别阶段失败，App 日志记录：

```text
Image count 5 exceeds limit 4 per request.
```

### 根因与修复

- `smartEditor.js` 将抽帧图片按每批 5 张发送给 Vision API，超过上游接口每次最多 4 张图的限制。
- 新增统一的 Vision 分批函数，将每个识别请求限制为最多 4 张图，同时保持全部帧的顺序和完整性。
- 新增 25 帧回归测试，验证分组结果为 `4/4/4/4/4/4/1`，不会漏帧或乱序。

### 验证

- 回归测试先在旧实现上失败，再在修复后通过。
- `node --test src/main/services/tests/*.test.js vendors/auto_dub_web/tests/*.test.mjs`：7 项通过。
- Voicebox Python 回归测试：3 项通过。
- `node --check src/main/services/smartEditor.js` 与 `git diff --check` 通过。
- `npm run build:mac` 通过。
- 根目录 App、构建目录 App 和 DMG 内 App 的 `app.asar` 哈希一致，包内 `MAX_VISION_IMAGES_PER_REQUEST=4`。
- App 产物：`/Users/chenxincheng/Desktop/my/Develop/Claude/AntBot/搬运蚁.app`
- DMG 产物：`/Users/chenxincheng/Desktop/my/Develop/Claude/AntBot/release/搬运蚁-0.3.6-mac-arm64.dmg`

## 当前架构

```
src/main/
  index.js              Electron 主进程入口
  ipc.js                所有 IPC handler（核心业务逻辑集中于此）
  preload.js            contextBridge 暴露给渲染进程的 API
  taskRunner.js         任务队列与串行执行
  services/
    autoDubClient.js    auto_dub_web 服务管理、语音克隆后端
    commandRunner.js    通用命令执行器
    config.js           配置管理
    dependencyInstaller.js  逐包 pip 安装、进度解析、取消（新增）
    dependencyManager.js    系统依赖检测（node/yt-dlp/ffmpeg 等）
    downloader.js       视频下载
    editor.js           剪辑调用
    fileUtil.js         文件工具
    gemini.js           Gemini 字幕生成
    parser.js           任务文本解析
    playwrightUtil.js   Playwright 浏览器管理
    publisher.js        视频号/抖音发布
    startupCheck.js     启动检查
    store.js            数据持久化
    systemControl.js    系统控制
    voiceClone.js       语音克隆流程入口
    runtimeEnv.js       运行时环境变量
    appInfo.js          应用信息

src/renderer/
  index.html            主页面
  app.js                渲染进程逻辑
  style.css             样式
  icons.js              SVG 图标定义
  anime.min.js          动画库

vendors/auto_dub_web/   剪辑配音引擎（内置）

scripts/                构建脚本
deploy/                 （已移除 fnOS 部署，保留目录结构）
```

## v0.3.6 主要变更

### 移除的内容
- Flutter 客户端 (`clients/antbot_flutter/`)
- fnOS Docker 部署方案 (`deploy/fnos/`)
- fnOS Relay App (`deploy/fnos-relay-app/`)
- 旧版远程控制页面 (`src/remote/`)
- Figma 资源文件 (`src/renderer/assets/figma/`)
- 旧版根目录文件 (`app.js`, `index.html`, `style.css`, `remoteControl.js`)
- voicebox 不必要的文件（tests、mlx backend 等）

### 新增
- `src/renderer/icons.js` — 集中管理 SVG 图标
- `src/renderer/anime.min.js` — 动画库
- `src/main/services/dependencyInstaller.js` — 逐包依赖安装模块
- Voicebox 环境管理面板（检测、安装、重置）
- 模型管理（list/download/delete）
- 字体管理、风格学习
- App logger（写入 `~/AntBot/logs/app.log`）

### 重构
- `ipc.js` — 从 455 行扩展到 ~1100 行，集中了大量新业务逻辑
- `renderer/app.js` — 精简重构，新的 UI 组件模式
- `style.css` — 改为紧凑格式，新的配色方案（暖色调 `--brand: #D57E3C`）
- `preload.js` — 从 43 行扩展到 76 行，暴露更多 API

## IPC 频道参考

### 核心
| 频道 | 方向 | 说明 |
|------|------|------|
| `app:get-initial-state` | invoke | 获取初始状态 |
| `app:state` | push | 状态更新推送 |
| `app:log` | invoke | 写入 app 日志 |

### 任务
| 频道 | 方向 | 说明 |
|------|------|------|
| `task:start` | invoke | 启动任务 |
| `task:stop` / `task:stop-one` | invoke | 停止任务 |
| `task:resume-one` | invoke | 恢复任务 |
| `task:progress` | push | 任务进度推送 |
| `task:log` | push | 任务日志推送 |

### 语音克隆
| 频道 | 方向 | 说明 |
|------|------|------|
| `voice:clone` | invoke | 执行语音克隆 |
| `voice:clone-progress` | push | 克隆进度推送 |

### Voicebox 环境管理
| 频道 | 方向 | 说明 |
|------|------|------|
| `voicebox:check` | invoke | 检查 venv 和依赖状态 |
| `voicebox:install` | invoke | 安装依赖（逐包进度） |
| `voicebox:install-cancel` | invoke | 取消安装（按包名或全局） |
| `voicebox:open-dir` | invoke | 打开 venv 目录 |
| `voicebox:reset` | invoke | 重置 venv 环境 |
| `voicebox:progress` | push | 安装整体状态推送 |
| `voicebox:deps-progress` | push | 逐包安装进度推送 |

### 依赖管理
| 频道 | 方向 | 说明 |
|------|------|------|
| `deps:get-state` | invoke | 获取系统依赖状态 |
| `deps:repair` | invoke | 修复缺失依赖 |
| `deps:install` | invoke | 安装单个依赖（如 whisper） |
| `deps:install-progress` | push | 依赖安装进度 |

### 模型管理
| 频道 | 方向 | 说明 |
|------|------|------|
| `models:list` | invoke | 列出模型 |
| `models:download` | invoke | 下载模型 |
| `models:delete` | invoke | 删除模型 |
| `models:progress` | push | 模型下载进度 |

### 其他
| 频道 | 方向 | 说明 |
|------|------|------|
| `startup:check` | invoke | 启动检查 |
| `settings:update` | invoke | 更新设置 |
| `dialog:pick-audio-file` | invoke | 选择音频文件 |
| `dialog:pick-video-file` | invoke | 选择视频文件 |
| `history:get` | invoke | 获取历史记录 |

## 依赖安装进度事件格式

`voicebox:deps-progress` 频道发送的事件结构：

```js
{
  type: 'package-start' | 'package-progress' | 'package-done' | 'package-error' | 'package-cancelled' | 'all-done',
  name: 'torch',           // 原始包名
  normalizedName: 'torch', // 标准化包名
  constraint: '>=2.1.0',   // 版本约束
  percent: 45,             // 0-100
  speed: '5.2 MB/s',       // 下载速度
  size: '900 MB / 2.0 GB', // 已下载/总大小
  message: '下载中...',     // 状态描述
  timestamp: '...'         // ISO 时间戳
}
```

## 构建

```bash
npm install
npm run dev              # 本地运行
npm run build:mac        # macOS App
npm run build:win        # Windows NSIS
npm run build:linux      # Linux AppImage
```

产物输出到 `release/`。

## 关键设计决策

1. **voicebox 依赖安装**：Node.js 直接管理 pip 子进程，逐包安装，解析 stderr 获取进度/速度，AbortController 支持取消
2. **voicebox 源码获取**：Node.js fetch 下载 GitHub zip，Python zipfile 解压，不依赖 git/bash
3. **venv 路径**：`~/AntBot/voicebox-env/.venv-voicebox/`（与 auto_dub_web 项目分离）
4. **App 日志**：写入 `~/AntBot/logs/app.log`，同时 console 输出
5. **任务系统**：不再按用户隔离（v0.3.6 简化），统一队列

## 注意事项

- macOS 打包使用 `icons.png` 生成 `icon.icns`
- Playwright Chromium 通过 `postinstall` 自动安装
- `vendors/auto_dub_web` 随构建打包
- 语音克隆后端（voicebox）首次使用需安装 Python 依赖，耗时较长
