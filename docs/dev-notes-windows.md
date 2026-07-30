# Windows 适配开发记录

## 日期：2026-07-29

## 踩坑记录

### 1. 安装目录只读（EPERM）
**问题**：Windows 默认装在 `C:\Program Files\AntBot\`，该目录对非管理员用户只读。桥接服务、voicebox 等组件尝试在这里写文件或运行 `npm install` 会失败。

**修复**：
- 桥接服务（`bridgeServiceManager.js`）：先复制 `local-server` 到 `~/AntBot/local-server/`（可写目录），再在那里启动
- voicebox（`autoDubClient.js`）：`cwd` 改为 `vendor/voicebox/`（正确的工作目录）
- 配置默认值（`config.js`）：`editProjectPath` 默认为空字符串，让运行时自动查找并复制到可写位置

### 2. `resolveDependencyPath()` 返回 Promise 未 await
**问题**：`resolveDependencyPath()` 是 async 函数，多处调用没有 `await`，导致传给 `spawn()` 的是 `[object Promise]` 而不是路径字符串。

**修复**：所有 `resolveDependencyPath()` 调用加 `await`。涉及文件：`ipc.js`、`smartEditor.js`。

### 3. `resolveFfmpegBin` 同步包装异步函数
**问题**：`smartEditor.js` 的 `resolveFfmpegBin` 是同步函数，内部调用异步的 `resolveDependencyPath`，返回 Promise 而不是字符串。

**修复**：改为 `async function`，所有调用处加 `await`。

### 4. `net.fetch` 不兼容标准 `fetch` API
**问题**：尝试用 Electron 的 `net.fetch` 替换全局 `fetch` 实现代理支持，但 `net.fetch` 的 Response 对象、请求格式和标准 `fetch` 不兼容，导致本地服务请求失败（`fetch failed`）。

**修复**：
- 移除全局 `fetch` 替换
- 只在 AI API 调用处（`smartEditor.js`）用 `http.request` + CONNECT 隧道实现代理
- 本地服务请求（auto_dub_web、voicebox、桥接）保持原生 `fetch` 不变

### 5. voicebox `cwd` 错误导致 `ModuleNotFoundError`
**问题**：voicebox 启动命令 `python -m backend.main` 的 `cwd` 设为 `auto_dub_web/`，但 `backend` 模块在 `auto_dub_web/vendor/voicebox/backend/`。

**修复**：Windows 上 `cwd` 改为 `path.join(projectPath, 'vendor', 'voicebox')`。

### 6. voicebox health check 不检查 `model_loaded`
**问题**：`fetchVoiceCloneStatus` 在 `/health` 端点返回 200 时就认为 voicebox 就绪，但此时 TTS 模型可能还在加载中。后续请求在模型加载期间发出会失败。

**修复**：检查 `health.model_loaded` 字段，只有模型加载完成才算就绪。

### 7. `fetchVoiceboxApi` 不支持 FormData
**问题**：voiceclone 上传音频用 `FormData`，但 `http.request` 不理解 FormData。Node.js 内置 `fetch()` 传 FormData 也不自动设置正确的 `Content-Type`。

**修复**：FormData 检测用 `constructor?.name === 'FormData'`，手动构建 multipart boundary + Buffer body，通过 `fetch()` 发送并显式设置 `Content-Type` 头。

### 8. 预置音色未在 voicebox 数据库注册
**问题**：预置音色下载只保存 WAV 文件到 `voicebox-data/profiles/<id>/ref.wav`，但 voicebox 用数据库管理 profiles，不知道文件存在。

**修复**：`resolveVoiceCloneProfile` 发现 profile 不存在但 WAV 文件存在时，自动调用 `createVoiceCloneProfileDirect` 注册到 voicebox。

### 9. WAV 路径不一致
**问题**：预置音色保存到 `~/AntBot/voicebox-data/profiles/`，但自动注册代码在 `AppData/Roaming/antbot/voicebox-data/` 找。

**修复**：统一用 `os.homedir() + '/AntBot/voicebox-data/'` 路径。

### 10. `spawn()` 缺少 `windowsHide: true`
**问题**：Windows 上 `spawn()` 默认会弹出控制台窗口，阻塞主进程。

**修复**：所有 `spawn()` 调用加 `windowsHide: true`。涉及：`ipc.js`、`autoDubClient.js`、`smartEditor.js`、`commandRunner.js`、`tunnelManager.js`、`bridgeServiceManager.js`、`dependencyInstaller.js`、`downloadManager.js`。

### 11. PATH 分隔符错误
**问题**：`downloadManager.js` 用 `:` 拼接 PATH，Windows 上应该是 `;`。

**修复**：改用 `buildRuntimePath()`（自动使用 `path.delimiter`）。

### 12. CUDA PyTorch 被 requirements.txt 覆盖
**问题**：安装流程先装 CUDA PyTorch，再运行 `pip install -r requirements.txt`，后者把 CPU 版 torch 装回来。

**修复**：CUDA PyTorch 安装移到 requirements.txt **之后**，使用 `--force-reinstall --no-deps`。

### 13. `AbortSignal.timeout()` 在 Electron 中不可靠
**问题**：`fetchVoiceboxApi` 用 `AbortSignal.timeout()` 做超时控制，在 Electron 的 Node.js 环境中不正常工作。

**修复**：改用 `http.request` + `setTimeout` + `AbortController`（更底层更可靠）。

### 14. PowerShell `Expand-Archive` 路径未转义
**问题**：路径含单引号或特殊字符时 PowerShell 命令失败。

**修复**：加 `escapePowerShellLiteral()` 转义，用 `-LiteralPath` 替代 `-Path`。

## 架构决策

### 不开新分支
所有改动在 `main` 上进行。改动本质是"补全平台分支"，不是重构。`if (process.platform === 'win32')` 就是设计意图。

### 代理策略
- 渲染进程：`session.defaultSession.setProxy({ mode: 'system' })` 自动走系统代理
- 主进程外部 API：`smartEditor.js` 用 `http.request` + CONNECT 隧道
- 主进程本地服务：原生 `fetch()` 直连，不走代理

### GPU 支持策略
- voicebox 启动时通过 `VOICEBOX_DEVICE` 环境变量传递设备偏好
- Python 后端 `_get_device()` 检查该变量，优先级：环境变量 > CUDA 自动检测 > CPU
- 设置页面提供"运行设备"下拉框（仅 Windows）：自动/GPU/CPU

---

## 日期：2026-07-30/31

### 15. `python3` 在 Windows 上不存在
**问题**：`resolveDependencyPath('python')` 返回空时 fallback 到 `'python3'`，但 Windows 上没有 `python3` 命令。导致 venv 创建静默失败，所有 pip 命令返回 -4058。

**修复**：fallback 改为平台感知 `|| (process.platform === 'win32' ? 'python' : 'python3')`。

### 16. venv 创建失败静默吞掉错误
**问题**：`child.on('error', () => resolve())` 把 venv 创建错误吞掉了，用户看不到任何失败信息。

**修复**：加 stderr 捕获和错误日志输出。

### 17. `pytorch_backend.py` 缺少 `import os`
**问题**：`_get_device()` 里用了 `os.environ.get('VOICEBOX_DEVICE', ...)` 但没 import `os`。voicebox 启动直接崩溃，Mac 和 Windows 都受影响。

**修复**：加 `import os`。教训：改 Python 文件时一定要验证 import 完整性。

### 18. voicebox 崩溃后重试不等就绪
**问题**：合成 500 错误后重启 voicebox，但没等模型加载完就重试，auto_dub_web 再次检查 voicebox 还是不可用。

**修复**：重启后循环等待 `getVoiceCloneProfiles()` 成功（最多60秒），确认 voicebox 真正就绪再重试。

### 19. 持久化主控任务状态
**问题**：`warning`（发布失败但视频已生成）状态存在 `progressRows` 内存中，重启后丢失，"重新发布"按钮消失。

**修复**：
- `warning`/`completed` 状态的任务保存到 `~/AntBot/main-control-tasks.json`
- 重启后加载并合并到主控界面显示
- 发布成功后自动清理持久化记录

### 20. 视频文件被删后点击重新发布
**问题**：用户在其他地方删除了成品视频，点击"重新发布"时报错。

**修复**：`task:republish` 检查 `outputPath` 是否存在，不存在时提示用户选择重新执行整个任务。

### 21. 发布时间过期显示
**问题**：定时发布时间已过的任务没有任何提示。

**修复**：`taskCard` 渲染时检查 `publishAt`，过期显示红色"发布时间已过期"标签。

### 22. 视频号登录检测 URL
**问题**：`login.html` 即使已登录也显示未登录。

**修复**：浏览器插件 `PLATFORM_LOGIN_URLS.weixin` 从 `login.html` 改为 `platform/`。发布 plugin v1.1.2。

### 23. 更新检查按钮次数限制
**问题**：检查到有更新后按钮一直 disabled，无法重新检查。

**修复**：发现更新后立即 `checkBtn.disabled = false`，按钮变为"重新检查"。

### 24. auto_dub_web HTTP 500 不检查状态码
**问题**：`postAutoDubProcessRequest` 返回后不检查 HTTP 状态码，500 错误被忽略。

**修复**：检查 `response.statusCode`，非 2xx 时解析响应体中的错误信息并抛出。
