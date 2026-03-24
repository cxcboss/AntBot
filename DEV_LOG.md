# 开发日志

## 2026-03-10
- 视频号发布：任务/活动选择采用 shadow-root-scope-v2，围绕 shadowRoot 搜索按钮/输入框/下拉选项，支持“微信小游戏 · 任务名”与任务名匹配，跳过“不参加任务”，无法匹配时关闭弹层并重试（最多 3 次）。
- Playwright 浏览器：mac 优先使用系统 Chrome；Chromium 缺失自动安装；检测 profile lock 时清理 SingletonLock/Socket/Cookie；Chromium 崩溃时回退系统 Chrome。
- 剪辑与配音：auto_dub_web 支持按 SRT 时间对齐语音（adelay），字幕背景移除，字幕/旁白开关控制输出。
- 设置与流程：新增 `subtitleEnabled`/`voiceoverEnabled`，设置页联动，关闭旁白时禁用字幕；任务流程在生成字幕与剪辑阶段按开关跳过。

## 2026-03-11
- 字幕来源：新增 Gemini 字幕网址设置，留空使用默认地址。
- 发布开关：新增“自动发布”设置，关闭时仅完成剪辑不发布。
- 失败重试：新增失败重试次数设置，任务完成后自动重试失败项。
