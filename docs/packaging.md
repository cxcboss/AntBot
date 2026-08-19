# 打包说明与版本记录

## 打包规则（必须遵守）

**每次打包 App 前，必须按「9 进制版本规则」递增 `package.json` 的 `version`**（不允许跳过、不允许重复使用相同版本号、不允许 patch 超过 9）：

```bash
npm version 0.6.6 --no-git-tag-version   # 示例：从 0.6.3 → 0.6.4
```

**9 进制版本规则**（patch/minor 最大到 9，到 9 后进位）：

| 当前版本 | 下一个版本 | 说明 |
|---------|-----------|------|
| 0.7.9 → | 0.8.0 | patch 到 9 → minor +1，patch 归 0 |
| 0.9.9 → | 1.0.0 | minor 到 9 → major +1，minor/patch 归 0 |
| 0.8.5 → | 0.8.6 | patch < 9 → 正常 +1 |

⚠️ **禁止使用 `npm version patch` 自动递增**（它会产生 `0.7.10` 这类违反规则的版本，导致后续 update 逻辑混乱）。必须手动指定目标版本号。

- 版本号唯一来源：`package.json` → `version`（构建时固化到二进制）
- 递增后必须在本文件「打包记录」表中登记：版本号、日期、本次修改内容
- 发布后本地版本号可回退为测试版本（见 release-guidelines.md 2.3），因此 **package.json 当前值不代表已发布版本，以 git tag 为准**
- **打包前**：按 9 进制规则手动指定新版本（`npm version <新版本> --no-git-tag-version`），并与 git tag 对齐

## 打包产物（用户要求只打目标平台文件）

### macOS（默认）

**只打包 .app 文件，不需要 dmg / zip**：

```bash
npm run build:mac
```

- 产物：`release/mac-arm64/搬运蚁.app`
- 构建完成后**必须将 .app 移动到项目根目录（对齐 Win 命名带版本号）**：
  ```bash
  V=$(node -p "require('./package.json').version")
  xattr -cr release/mac-arm64/搬运蚁.app
  codesign --force --deep --sign - release/mac-arm64/搬运蚁.app
  cp -R release/mac-arm64/搬运蚁.app ./搬运蚁-${V}-mac-arm64.app
  ```
- 交付位置：项目根目录 `搬运蚁-{版本号}-mac-arm64.app`
- 例：`搬运蚁-0.8.7-mac-arm64.app`、`搬运蚁-0.8.8-mac-arm64.app`

### Windows（仅当用户明确要求时）

**只打包 win 的 exe 文件**，同样先更新版本号（+0.0.1）：

```bash
npm run build:win        # NSIS 安装器 → release/*.exe
npm run build:win:portable   # 或便携版 exe
```

- 产物：`release/` 下的 `.exe` 文件
- 构建完成后**必须将 exe 文件移动到项目根目录**
- 交付位置：项目根目录

## 打包记录

| 版本 | 日期 | 修改内容 |
|------|------|---------|
| 0.8.8 | 2026-08-20 | 修复远程主控重复任务卡片：统一实时/持久化/历史任务 ID，跨来源去重；重试历史只保留最终 attempt；同步当前热更新页面缓存 |
| 0.8.7 | 2026-08-20 | 修复主控任务卡片重复：persisted task 用 `id` 字段而 history item 用 `taskId` 字段，去重过滤器误查 `t.taskId`（恒 undefined）导致 persisted 永远不被过滤；修复为同时检查 `t.id`/`t.taskId` 并在 persisted entry 补 `taskId` 字段 |
| 0.8.6 | 2026-08-19 | 修复远程主控音色/风格弹窗异步内容加载后未重新定位，弹窗向下溢出输入栏并裁切列表；远程音色接口与 App 端统一合并 Azure 内置音色和有效克隆音色；远程页面发布 v1.9.3 |
| 0.8.5 | 2026-08-19 | 远程 1.9.2 + 监控 + UI 全优：① 修复远程音色/风格弹窗箭头缺 data-arrow 导致折叠异常，居中/防溢出/移动端适配；② 远程新增平台退出登录（douyin/weixin cookies 清理 + 桥接 platform.logout + 本地 cookies 文件清理）；③ 远程字幕简化为单自定义颜色选择器（去预选色块/HSL），预览+原生拾色；④ 远程UI 全面优化：卡片悬停、芯片弹窗移动端自适应、安全区适配、版本动态 `APP_VERSION`；⑤ 去掉App风格学习视频按钮及弹窗/处理逻辑，仅保留文本风格；⑥ 新增监控 YouTube 博主（侧边栏 eye 图标 + 独立视图/弹窗 + 频率 每30分/1时/2时/6时/每天 + 平台/话题/风格/音色/原创/活动 独立覆盖 + 首次记录不下载 + flat-playlist 检测 + 自动入队主控流水线 + 持久化 ~/AntBot/monitors.json + 定时调度 + taskRunner 语音/风格 per-task 覆盖）；⑦ 桥接 cookies 权限追加 |
| 0.8.4 | 2026-08-19 | 桥接可靠性全面加固（稳定连接+自动恢复+自动拉起浏览器，Win/Mac 全适配）：① 动态选口 18321-18331（busy 端口自动递增，App/插件 11 口扫描，配置文件 ~/AntBot/bridge-port.json，manifest host_permissions 改 * 通配）；② 服务自愈：HTTP 健康探活替代 TCP、30s 启动超时、看门狗 10s 定时 + 崩溃立即重启，修复假运行/误杀外部进程；③ 插件保活：fetch 加 10s AbortController、bridgeBusy 10s 自解锁、Offscreen 文档保活（AUDIO_PLAYBACK）、端口漂移感知、content 仅主 frame 响应；④ 发布链路按需拉起：publisher ensureBridgeReady 自动启动服务+轮询健康+30s 等待插件连接，失败时 shell.openExternal/Spwan 拉起 Chrome 新窗口（Win/Mac 路径适配，不抢焦点仅定时 fallback 激活），发布页 5s 状态轮询 + 打开浏览器按钮 + 端口显示；⑤ 时延优化：INACTIVITY 90s→动态 90-300s（按视频大小）、轮询退避 700→1500ms、登录/发布超时容错；⑥ local-server 加固：remoteAddress 校验替代 Host 头、CORS 白名单、health 详情、Range 合法性、路径解码穿越防护；⑦ 浏览器启动器新增 browserLauncher.js（Win ProgramFiles/LocalAppData + Mac /Applications 适配，windowsHide/unref）；⑧ 可写目录全量 hash 校验 + node_modules 完整性检查 |
| 0.8.3 | 2026-08-19 | Windows 兼容全面加固（Win10+ x64）：① 编码器功能性探测（1 帧试编码，qsv→nvenc 逐个验证驱动，最终兜底 libx264），合成运行期编码器失败自动降级 libx264 重试，不再因 N 卡驱动过旧硬失败；② Windows 禁用 system TTS（say 仅 macOS）；③ voicebox 去 Git Bash 依赖（Windows 原生 python -m venv + pip，后端复制到 ~/AntBot/auto-dub-web 可写目录运行，记录 torch 来源防 CPU/CUDA 互相覆盖，补 child.unref）；④ local-server 绑 127.0.0.1 + Host 校验 + 路径穿越校验（消防火墙弹窗与局域网风险）；⑤ 依赖下载链（ffmpeg/yt-dlp/node/cloudflared/CF API）统一走系统代理（proxyFetch + ProxyServer 多协议格式修复）；⑥ npm 托管解析（node-runtime npm-cli.js）；⑦ 7 处 execSync/execFile 补 windowsHide；⑧ 默认输出目录改用 app.getPath('desktop')（OneDrive 重定向）；⑨ win 更新 asset 精确匹配（排除 portable）；⑩ canRunBinary 超时 Windows 放宽 5s + 跳过 Store 桩；⑪ 中文字体兜底（Arial/Segoe UI）+ 存在性校验；⑫ 缩略图 30s 超时 + stderr；⑬ NSIS 中文安装器（zh_CN/en_US）+ build.files 加 assets/icon.png；⑭ 临时目录清理失败记日志。含 0.8.2 全部改动，合成一个版本 |
| 0.8.2 | 2026-08-19 | 修复主控不显示历史记录+发任务报 map 错误（chatGroupSig 误用 tasks 数组，改用 tasksHtml 签名）；更新页新增浏览器插件"安装插件"按钮+安装教学；浏览器插件支持 App 启动自动更新；全部报错信息中文化（timeout/ffmpeg failed/Not found/fetch failed/HTTP 状态码/npm install exit 等）；远程状态页修复手机端无法滚动（100vh→100dvh），远程页面 v1.9.1。仅打 mac 测试包（未发布） |
| 0.8.1 | 2026-08-19 | 主控流畅度优化（A 渲染节流 100ms 合并 + B 时间线增量渲染只重建变化任务组 + C 主进程 progress 推送 200ms 节流 + D 历史 run-group content-visibility）；修复远程状态页"远程服务"误报已停止（探测端口硬编码 18931 改为实际端口 17888）；远程主控同步 App（任务卡片状态/按钮/取消遮罩/chips 音色分类弹窗等，远程页面 v1.9.0）；移除远程状态页磁盘/内存显示；远程新增重新发布接口；Win 更新页支持直接下载安装包到下载目录（含前往 GitHub 兜底按钮） |
| 0.8.0 | 2026-08-19 | 修复主控定时发布任务完成后仍显示"定时已过期"（completed/warning 状态不再显示过期标签）；版本规则改为 9 进制进位（patch/minor 到 9 进位），0.7.10 后续版本统一为 0.8.0 |
| 0.7.10 | 2026-08-19 | 修复远程访问失败：cloudflared 命名隧道 config.yml 的 ingress 端口与服务端口不一致（18931 vs 17888），启动隧道时自动同步端口 |
| 0.7.9 | 2026-08-19 | 无音色时默认内置晓晓（女·温柔）；无风格时默认通用风格；新增"通用风格"内置风格；edit bar 风格/音色选择持久化 |
| 0.7.8 | 2026-08-19 | 修复剪辑到"待合成"卡住（第二次修复）：_runPrepare 完成后漏调 _tick()，导致合成阶段无法调度启动 |
| 0.7.7 | 2026-08-19 | 修复剪辑到"待合成"阶段卡住：_runPrepare 完成后未调用 _tick() 触发合成 |
| 0.7.6 | 2026-08-19 | 修复远程密码因打包后 safeStorage 签名失效无法解密（改用 SHA-256 hash 验证，不依赖系统密钥）；修复 voice 弹窗因音色过多不可点击（加 max-height/overflow）；voice 弹窗改为可折叠分组（内置音色/克隆音色） |
| 0.7.5 | 2026-08-19 | 内置 Azure TTS 免克隆音色（msedge-tts，11 个中文音色）；语音克隆改为非必须（未安装也可用内置音色）；修复长视频字幕时间轴误差（smartEditor 去尾部 break 丢弃改为等比压缩，videoComposer 新增语音驱动时间轴微调）；voices:list 合并内置音色 |
| 0.7.4 | 2026-08-18 | 修复 Qwen3 TTS 模型下载失败（models.js 误用 fs/promises 的 createWriteStream） |
| 0.7.3 | 2026-08-18 | 修复 Win 首次安装依赖失败（Python 3.13 支持 + numba 约束改写 + pip 超时重试 + venv 失败中止）；修复更新检测不到（releases 空回退 tags API、远程页面改走 GitHub API、手动检查强制绕缓存） |
| 0.7.2 | 2026-08-13 | 发布页 v2 重设计——每视频×每平台独立参数（原创/定时5天窗口/活动/文案/话题）、复制参数、应用到全部、抖音活动定时互斥、定时过期降级立即发布、任务持久化 |
| 0.7.1 | 2026-08-11 | 修复设置页'添加Key'按钮——保存推送重建表单清掉新行，fillForm 改为保留现有 keys DOM 只补齐缺失 |
| 0.7.0 | 2026-08-10 | 主控界面翻新——消息直接显示原文（去原文按钮保留复制）；历史记录 schema 升级清空+写入去重；任务卡片 meta 标签化活动名直显；优化按钮空输入隐藏+AI解析取消兜底 |
| 0.6.9 | 2026-08-07 | 修复网页端音色/风格同步：网页端 POST editDefaults 分流写入 ui-settings.json（style）与 voiceClone（voice，反查 voices.json id），与 App 端写入路径一致，任务执行能正确读取；远程页面 v1.8.0（登录页深浅色跟随优化、密码可见切换、连接 loading 态、设备在线点、加密提示） |
| 0.6.8 | 2026-08-07 | 修复远程设备不显示：隧道连接与 Hub 注册解耦（onConnected 不再被超时 resolved 短路），注册改用系统代理 CONNECT 隧道（Node fetch 不走代理导致 fake-ip 环境注册失败），隧道启动超时 30s→90s，autoStart 失败自动重试 3 次，remote 日志写入 app 日志文件 |
| 0.6.7 | 2026-08-07 | UI 全量中性极简重构（去 Teal）；主控时间线/规则面板/任务卡新结构；启动动画（物理弹跳+mask 遮罩展开）；消息按时间排序；设置页开机自启开关 + AI 多 key 轮值；远程页面同步重构；远程页面 v1.7.0 已推送 |
| 0.6.6 | 2026-08-07 | 例行打包（当前代码基线，含远程页面中性化重构、启动动画、消息排序、开机自启等全部改动） |
| 0.6.4 | 2026-08-07 | 例行打包（当前代码基线，含远程页面中性化重构、启动动画、消息排序、开机自启等全部改动） |
| 0.6.3 | 2026-08-07 | 版本号基线调整（0.5.6 → 0.6.3）；打包产物规则明确：mac 只打 .app、win 只打 exe，均移动到项目根目录 |
| 0.5.6 | 2026-08-07 | 主控消息按时间排序（最新在底部）；设置页新增开机自动启动开关（Mac/Windows）；启动动画调整（下落加速、放大 1.3s、覆盖全窗）；修复主控历史消息截断问题 |
