# 远程控制页面热更新文档

## 概述

远程控制的登录页（remote-ui）和 Hub 设备列表页采用热更新机制，修改后无需重新打包 App。页面文件托管在 GitHub，App 启动时自动检查并下载更新。

## 相关文件

### 源码文件

| 文件 | 作用 |
|------|------|
| `src/main/services/remoteUpdater.js` | 热更新核心模块（检查/下载/推送/备份/校验） |
| `src/main/services/remoteServer.js` | 远程 HTTP 服务器，`getMobileHTML()` 优先从数据目录加载 |
| `src/main/ipc.js` | IPC handler：`remote:check-update`、`remote:do-update`、`remote:get-local-version` |
| `src/main/preload.js` | Bridge：`remoteCheckUpdate`、`remoteDoUpdate`、`remoteGetLocalVersion`、`onToast` |
| `src/main/index.js` | App 启动时调用 `updater.autoUpdate()`，完成后发送 Toast 通知 |
| `src/renderer/index.html` | 远程设置页面的版本显示和检查更新按钮 |
| `src/renderer/app.js` | `initRemotePage()` 中的更新检查逻辑 + `onToast` 监听 |
| `workers/antbot-hub/src/index.js` | Hub Worker，KV 缓存 HTML + `/api/update-html` 端点 |

### GitHub 仓库

**仓库地址**：https://github.com/cxcboss/antbot-remote-ui

```
antbot-remote-ui/
├── version.json           ← 版本清单（必须更新）
├── remote-ui/
│   └── index.html         ← 登录页 + 管理页（单文件）
└── hub/
    └── index.html         ← Hub 设备列表页（单文件）
```

### 本地数据目录

```
~/AntBot/remote-ui/
├── version.json           ← 本地版本记录
├── remote-ui/
│   └── index.html         ← 本地登录页 + 管理页
├── hub/
│   └── index.html         ← 本地 Hub 页面
└── .backup/               ← 旧版本备份（自动管理）
    └── v1.0.1/
        ├── version.json
        ├── remote-ui/index.html
        └── hub/index.html
```

## 发布新版本的步骤

### 1. 修改页面文件

- `src/main/services/remote-ui/index.html`：登录页 + 管理页
- `workers/antbot-hub/src/index.js` 中的 `HTML` 常量：Hub 设备列表页

### 2. 同步修改到 GitHub 仓库

```bash
# 克隆仓库（如果还没有）
cd /tmp && git clone https://github.com/cxcboss/antbot-remote-ui.git
cd antbot-remote-ui

# 复制文件（从 App 源码目录）
cp /path/to/AntBot/src/main/services/remote-ui/index.html remote-ui/index.html

# 提取 Hub HTML（从 Worker 源码中的 HTML 常量）
node -e "
const fs = require('fs');
const src = fs.readFileSync('/path/to/AntBot/workers/antbot-hub/src/index.js', 'utf-8');
const match = src.match(/const HTML = \x60([\s\S]*?)\x60;/);
if (match) fs.writeFileSync('hub/index.html', match[1]);
"

# 更新版本号（必须！使用语义化版本）
# 编辑 version.json，递增 version 字段
```

### 3. version.json 格式

```json
{
  "version": "1.0.2",
  "publishedAt": "2026-07-28T15:00:00Z",
  "files": {
    "remote-ui/index.html": { "sha256": "可选的sha256哈希" },
    "hub/index.html": { "sha256": "可选的sha256哈希" }
  }
}
```

**版本号规则**（语义化版本 semver）：
- `major.minor.patch`（如 `1.0.2`）
- 不支持版本回退（新版本号必须大于旧版本号）
- 比较规则：major > minor > patch（数字比较，非字符串）

### 4. 推送到 GitHub

```bash
git add -A
git commit -m "v1.0.2: 描述修改内容"
git push origin main
```

### 5. 验证

```bash
# 确认版本号已更新
curl https://raw.githubusercontent.com/cxcboss/antbot-remote-ui/main/version.json

# App 启动时会自动检测并下载
# 或在设置中手动点击"检查更新"
```

## App 端更新流程

```
App 启动
  ↓
读取 ~/AntBot/remote-ui/version.json（无则视为 v0.0.0）
  ↓
用 curl 从 GitHub 获取 version.json（支持系统代理）
  ↓
semver 比较版本号
  ├── 当前 >= 远程 → 跳过
  └── 远程更新 → 逐文件下载（每个文件最多重试 3 次）
                    ↓
                  SHA256 校验（如果 version.json 中提供了 hash）
                    ↓
                  全部成功 → 备份当前版本到 .backup/
                    ↓
                  更新本地 version.json
                    ↓
                  推送 hub/index.html 到 Cloudflare Worker（KV 缓存）
                    ↓
                  发送 Toast 通知到渲染端
```

## Hub Worker 更新机制

- **KV Key**：`hub-html-cache`
- **TTL**：7 天
- **写入**：App 下载更新后调用 `POST /api/update-html` 推送（用 curl）
- **读取**：Worker 处理 `/` 请求时优先从 KV 读取，找不到用内嵌版本
- **查看版本**：`GET /api/html-version`

## 容错设计

| 场景 | 行为 |
|------|------|
| GitHub 不可达 | 静默忽略，使用本地缓存或内置版本 |
| 下载单个文件失败 | 自动重试 3 次（间隔递增），仍失败则保留旧版本 |
| SHA256 校验失败 | 跳过该文件且**不写入磁盘**（先校验后落盘），不更新版本号 |
| 本地目录不存在 | 自动创建 |
| KV 缓存过期 | Worker 回退到内嵌版本 |
| App 未启动 | 不会自动更新，下次启动时检查 |
| 更新后有问题 | 可从 `.backup/vX.X.X/` 目录恢复旧版本 |

## Hub Worker 安全机制（v1.2.0 起）

| 机制 | 说明 |
|------|------|
| 共享密钥鉴权 | `/api/register`、`/api/unregister`、`/api/update-html` 必须带 `x-hub-secret` 头；密钥 = `env.HUB_SECRET`（`wrangler secret put HUB_SECRET=xxx` 可覆盖），默认值与 App 端 `src/main/services/hubConfig.js` 一致 |
| 设备唯一 ID | 设备注册 key 从 deviceName 改为 `deviceId`（App 生成 UUID 持久化在凭证文件），重名设备不再互踢，换设备名不残留旧注册 |
| verify 限速 | 每设备 10 分钟最多 5 次密码失败（Worker 内存态） |
| 设备端防护 | 远程登录 1 小时失败 10 次锁 15 分钟；会话 token 24 小时过期；改密码立即清空全部会话 |

## 远程凭证存储（v1.2.0 起）

- **唯一密码来源**：`~/AntBot/remote-credentials.json`（App 桌面端、远程页面改密、autoStart 全部走这里）
- 密码用 Electron `safeStorage` 加密（macOS Keychain / Windows DPAPI），不再明文存储
- 远程页面 localStorage 不再保存密码明文，只存 24h 过期的会话 token
- 旧版写 `antbot-store.json` 的 `settings.remote.password` 路径已废弃（store 会强制清空且登录不读取）

## 网络说明

- **下载使用 curl**（通过 `child_process.execFile`），自动走系统代理
- **Hub 推送使用 curl POST**，同样走系统代理
- 不使用 Node.js `fetch`（不支持系统代理）

## 重要注意事项

1. **版本号必须递增**：使用 semver 格式，版本号不变或降低不会触发更新
2. **HTML 是单文件**：remote-ui/index.html 包含所有 CSS/JS，不引用外部资源
3. **不要删除 GitHub 仓库中的文件**：如果某个文件不需要更新，保留旧版本即可
4. **Hub Worker 内嵌 HTML 是兜底**：即使 KV 缓存过期且 GitHub 不可用，Hub 页面仍能正常显示
5. **修改 remote-ui 后也要同步到 App 内置版本**：热更新是增量机制，新安装的 App 使用内置版本
6. **旧版本自动备份**：更新前会备份当前版本到 `.backup/vX.X.X/`，可手动恢复

## 更新 checklist

每次修改远程页面相关功能时，检查以下所有位置：

- [ ] `src/main/services/remote-ui/index.html` — App 内置版本（必须同步修改）
- [ ] `workers/antbot-hub/src/index.js` — Worker 内嵌 HTML 常量（必须同步修改）
- [ ] GitHub 仓库 `antbot-remote-ui` — 推送新版本（必须）
- [ ] `version.json` — 递增版本号（必须，semver 格式）
- [ ] 如果修改了 IPC/API → 检查 `ipc.js`、`preload.js`、`remoteServer.js`
- [ ] 如果修改了设置 UI → 检查 `index.html`、`app.js`
- [ ] 如果修改了 Hub Worker API → 检查 `src/main/services/hubConfig.js` 的 `HUB_SECRET` 是否与 Worker 端一致
- [ ] Hub Worker 有改动 → 重新 `wrangler deploy`
- [ ] App 有改动 → 重新 `npm run build:mac`
- [ ] 验证：App 启动后检查更新是否正常、页面是否加载最新版本
