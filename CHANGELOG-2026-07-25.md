# 开发记录

## 2026-07-25: UI 设计系统重构 + 音色/风格内置

### 一、UI 设计系统重构

基于 shadcn/ui 设计理念，对整个 App 的前端进行了系统性重构。

#### 1.1 设计 Token 系统（新建 `design-tokens.css`）

- **主题色**：从橙色 `#D57E3C` 改为青色 Teal `#0D9488`
- **暗色模式**：从 `prefers-color-scheme` 媒体查询改为 class-based `.dark` 切换，自动跟随系统
- **语义化变量**：`--brand` → `--primary`，`--surface` → `--card`，`--green` → `--success` 等
- **新增系统**：
  - 5 级阴影：`--shadow-xs` ~ `--shadow-lg`
  - 6 级圆角：`--radius-xs`(4px) ~ `--radius-full`(9999px)
  - 3 级过渡动画：`--transition-fast`(120ms) / `--transition-normal`(200ms) / `--transition-slow`(300ms)
  - 4px 基准间距网格
- **向后兼容**：保留 `--brand`/`--bg`/`--surface` 等旧变量别名

#### 1.2 图标系统迁移到 Lucide（重写 `icons.js`）

- 从手写 SVG 迁移到 [Lucide Icons](https://lucide.dev)（`lucide-static` 包）
- 49 个图标全部内联为 SVG 字符串（避免 bare import 导致白屏）
- 新增图标：`scissors`、`sparkle`、`film`、`sun`、`moon`、`clock`、`eye`、`eyeOff` 等
- 侧边栏图标重新分配：
  - 主控 `play` → 剪辑 `scissors` → 发布 `send` → 风格参考 `sparkle` → 字幕与音色 `mic`

#### 1.3 组件样式精修（更新 `style.css`）

- **按钮**：高度 28px → 32px，新增 `focus-visible` ring
- **输入框**：统一 h-32px，focus 时 `box-shadow: 0 0 0 3px` ring
- **卡片**：新增 `--shadow-xs` 静止阴影，hover 边框变深
- **对话框**：`backdrop-filter: blur(4px)`，`--shadow-lg` 阴影
- **Toast**：宽度统一 320px，各状态用语义色
- **间距统一**：5px/7px/10px 等替换为 4px 倍数

#### 1.4 发布页响应式重构

- 平台选择：`<select>` 下拉改为两个按钮（视频号/抖音），选中高亮
- 原创/定时：checkbox 改为圆形 toggle 开关
- 文案+话题：从左右并排改为上下全宽
- 定时选择器：默认隐藏，打开定时开关才显示
- 月份下拉：从 HTML 硬编码改为 JS 动态生成
- 小窗口响应式：flex-wrap + 纵向堆叠

### 二、内置风格（10 个）

内嵌到 `ipc.js` 的 `BUILTIN_STYLES` 常量中，首次启动自动合并到用户风格库。

| 风格 | 适用场景 |
|------|---------|
| 电影解说 | 影视解说、剧情回顾 |
| 探店vlog | 美食探店、实地体验 |
| 儿童游戏 | 亲子互动、游戏内容 |
| 儿童手工 | 手工教程、DIY 内容 |
| 生活日常 | Vlog、日常记录 |
| 知识科普 | 科技/历史/科学解说 |
| 搞笑段子 | 搞笑短视频、吐槽 |
| 情感文案 | 情感号、治愈系内容 |
| 美食制作 | 做饭教程、食谱分享 |
| 旅行记录 | 旅行 vlog、风景分享 |

设置页新增「重新加载内置风格」按钮，用户删除后可恢复。

### 三、预置音色下载

#### 3.1 音色克隆

使用 App 的 voicebox 后端批量克隆了 10 个音色：

| 音色 | 来源 | Profile ID |
|------|------|-----------|
| TVB女生 | TVB女生（内置）.mp3 | d7c2a5bc-... |
| 乌萨奇 | 乌萨奇（内置）.mp3 | d300bf09-... |
| 奶龙 | 奶龙（内置）.mp3 | 9e995fff-... |
| 小姐姐 | 小姐姐（内置）.mp3 | 2539715f-... |
| 懒羊羊 | 懒羊羊（内置）.mp3 | 663d5b81-... |
| 曼波 | 曼波（内置）.mp3 | fbba9bb7-... |
| 熊二 | 熊二（内置）.mp3 | 92cf4cb6-... |
| 猪妞 | 猪妞（内置）.mp3 | 3c3a3e88-... |
| 蜡笔小新 | 蜡笔小新（内置）.mp3 | 5f63208d-... |
| 解说小帅 | 解说小帅（内置）.mp3 | 691d625f-... |

音频格式：PCM 16-bit, mono, 24kHz, 30秒以内

#### 3.2 GitHub 仓库

- 仓库：https://github.com/cxcboss/antbot-voice-models
- Release v1.0：10 个 zip 文件 + manifest.json
- 每个 zip 内含：`ref.wav`（参考音频）+ `meta.json`（元数据）
- 文件名使用英文避免上传问题

#### 3.3 App 内下载功能

- 「字幕与音色」页面新增「预置音色」区域
- 从 GitHub 获取 manifest.json 展示列表
- 已安装的显示 ✓ 已安装，未安装的显示下载按钮
- 下载流程：fetch zip → extract → 复制 WAV 到 profiles/ → 注册到 voices.json
- 新增 IPC：`voice:download-preset`
- 删除音色后预置列表即时刷新

### 四、API 额度显示优化

- "可剪辑时长"数字颜色：从绿色改为默认前景色
- 侧边栏每个 key 的显示：从 `1450/1500`（次数）改为 `X小时X分`（时间）
- 核实结论：每次 AI 调用（成功/失败/限频）都已正确记录，数据持久化到 `api-usage.json`，按天自动重置

### 五、批量克隆脚本

- `scripts/batch-clone.mjs`：独立 Node.js 脚本，通过 voicebox HTTP API 批量克隆
- `scripts/batch-clone-voices.mjs`：通过 Electron IPC 克隆（需 App 运行）

### 六、文件变更清单

| 文件 | 变动 |
|------|------|
| `package.json` | +`lucide-static` |
| `src/renderer/design-tokens.css` | **新建** — 设计 token 系统 |
| `src/renderer/default-styles.json` | **新建** — 内置风格 JSON（备用） |
| `src/renderer/icons.js` | **重写** — Lucide 图标内联 |
| `src/renderer/style.css` | **大改** — 变量替换 + 组件精修 + 响应式 |
| `src/renderer/index.html` | 中改 — 新增预置音色区、设置按钮、图标调整 |
| `src/renderer/app.js` | 大改 — 主题跟随系统、预置音色下载、内置风格加载 |
| `src/main/ipc.js` | 大改 — 内置风格、音色下载/批量克隆 IPC |
| `src/main/preload.js` | 小改 — 新增 API 桥接 |
| `CLAUDE.md` | 中改 — 新增设计系统规范 |

### 七、已知问题与后续

- `default-styles.json` 文件因 JSON 引号问题无法正常解析，已改用 JS 内嵌方案
- 预置音色依赖 GitHub 网络访问，离线环境无法下载
- 批量克隆脚本需要 voicebox 后端环境（Python venv + CosyVoice 模型）
