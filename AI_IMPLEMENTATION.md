# 功能实现方法（AI识别）

## Feature: 字幕与旁白开关
- Settings keys: `settings.style.subtitleEnabled` 与 `settings.style.voiceoverEnabled`，默认 true。
- UI: `src/renderer/index.html` 增加两个下拉选项；`src/renderer/app.js` 保存设置并做联动。
- 规则: 旁白关闭时强制字幕关闭并禁用字幕开关。
- 流程入口: `src/main/services/config.js` 默认值；`src/main/taskRunner.js` 决定是否生成字幕；`src/main/services/editor.js` 与 `src/main/services/autoDubClient.js` 传递开关给 auto_dub_web。

## Feature: Gemini 字幕网址配置
- Settings key: `settings.subtitle.geminiUrl`，留空走默认 `https://gemini.google.com/gem/ae555326c619`。
- UI: `src/renderer/index.html` 增加输入框；`src/renderer/app.js` 读写设置。
- 入口: `src/main/services/gemini.js` 使用 `resolveGeminiUrl(settings)`。

## Feature: auto_dub_web 处理请求与字幕模式
- 入口: `src/main/services/autoDubClient.js` 的 `processWithAutoDub`。
- 接口: `POST http://127.0.0.1:5001/api/process`，携带视频与 SRT 文件。
- 关键字段: `subtitle_enabled` 与 `voiceover_enabled`，并在响应中校验 `subtitleMode` 为 `burned` 或 `none`。
- 规则: 旁白关闭或字幕关闭时，不允许 `subtitleMode` 仍为 `burned`，否则视为异常。

## Feature: 语音与字幕时间对齐
- 入口: `vendors/auto_dub_web/server.mjs` 的 `buildVoiceoverTrack`。
- 规则: 逐条 SRT 使用 `adelay` 按 `startMs` 延迟，且延迟会乘以 `dub_speed`（语速）。
- 结果: 每条语音起始时间与字幕时间一致。

## Feature: 字幕无背景
- 入口: `vendors/auto_dub_web/server.mjs` 的 `buildDrawtextFilter` 与 `composeVideo`。
- 规则: `drawtext` 使用 `box=0`，ASS 字幕样式 `BackColour=&H00000000`，确保无黑底。

## Feature: 视频号任务/活动选择
- 入口: `src/main/services/publisher.js` 的 `selectWeixinActivity`。
- 策略: `shadow-root-scope-v2`，只在 `shadowRoot` 内定位按钮、输入框与下拉项。
- 流程: 点击“活动/任务”区域，等待 2 秒，输入任务名，等待 2 秒，按方向键触发下拉，等待列表加载后选择。
- 匹配规则: 归一化文本去空格与分隔符，移除“微信小游戏/任务/活动”前缀，匹配任务名或“微信小游戏 · 任务名”。
- 选择规则: 跳过“不参加任务/不参与/不加入/不设置”，若首项为不参加则选择第二项。
- 验证与重试: 选择后检查页面是否出现目标文本，失败会关闭弹层并重试，最多 3 次。

## Feature: 发布开关
- Settings key: `settings.publish.enabled`，默认开启。
- 入口: `src/main/taskRunner.js`，关闭时跳过 `publish` 步骤并记录 `publishMode=disabled`。
- 规则: 关闭发布时不写入 publishedRecords。

## Feature: 失败后自动重试
- Settings key: `settings.retry.failedTaskRetries`，默认 0。
- 入口: `src/main/taskRunner.js`，完成全部任务后再重试失败项。
- 规则: 每轮重试只处理失败任务，成功后从队列移除，最多重试 N 次。

## Feature: Playwright Chromium 启动回退（mac）
- 入口: `src/main/services/playwrightUtil.js` 的 `launchPersistentChromiumContext`。
- 规则: 优先使用与当前 Playwright revision 匹配的 Chromium；未安装时自动安装；profile 被占用时清理 SingletonLock/Socket/Cookie；检测到 Chromium 损坏、崩溃或 revision 不匹配时强制修复后重试；mac 默认不再自动切到系统 Chrome，除非显式开启 `ANTBOT_ALLOW_SYSTEM_CHROME_FALLBACK=1`。

## Feature: 多用户隔离与共享语音克隆
- Store: `src/main/services/store.js` 将数据升级为 `users[] + activeUserId + sharedVoiceClone`。
- 隔离范围: 视频号、抖音 登录态；任务历史；发布记录；浏览器 profile；全部设置。
- 共享范围: `settings.voiceClone` 由 `sharedVoiceClone` 同步到所有用户，语音克隆成果可以跨用户复用；Gemini 浏览器 profile 和登录状态按共享模式处理，可供多个用户复用同一套 Gemini 环境。
- 默认用户: 首次迁移自动生成 `蚂蚁1`，后续可在桌面端或远程端改名并新增用户。
- 数据持久化: Store 采用原子写入；应用用户数据目录固定到稳定的 `appData/antbot` 路径，并兼容旧目录迁移，避免重启后恢复默认。

## Feature: 桌面端紧凑首页与卡片式用户切换
- UI: `src/renderer/index.html`、`src/renderer/style.css`、`src/renderer/app.js`。
- 首页: 默认只显示必要状态、任务输入和固定在顶部的开始/调试/停止/启动检查按钮。
- 隐藏页: 进度、历史、用户管理通过顶部导航切换，不再默认占据主界面。
- 用户交互: 新建用户不再依赖系统 `prompt`，改为用户页里的输入框和卡片式切换按钮；头部支持快速切换用户；创建用户后自动切到新用户；支持删除用户；切换/创建/改名/删除时显示明确的进行中状态。
- 执行规则: 任务执行中允许切换用户继续提交新任务，但 stop 只允许当前执行任务所属用户操作；进度卡片会显示任务归属用户和重试次数。

## Feature: 远程端三页导航与用户隔离草稿
- UI: `src/remote/index.html`、`src/remote/app.js`、`src/remote/style.css`。
- 页面结构: 远程端拆成 `主页 / 任务 / 设置` 三页；任务输入和启动区单独放到第二页，主页保留状态、进度、日志，并把状态块下移。
- 草稿隔离: 远程任务输入框按 `userId` 本地缓存，切换用户后不会继续显示其他用户输入的任务文本。
- 队列提示: 远程端会显示当前执行用户、排队批次和排队列表；当正在执行的是其他用户的任务时，当前用户仍可继续提交排队，但不能停止别人的任务。
- 用户上下文: 远程端接口改为按请求里的 `userId` 读取对应用户数据，不再因为旧网页轮询或旧登录态把桌面端当前用户偷偷切回去。

## Feature: 远程密码默认值
- 默认值: `settings.remote.password` 默认填充为 `1`。
- 迁移: 旧用户若密码为空，会在加载时自动补成 `1`，后续仍可单独修改。

## Release Rule: 修改同步升级版本号
- 规则: 每次功能修改或打包前，同步更新 `package.json` 的 `version`，桌面端标题、远程端标题和安装包文件名会自动带出新版本号。
