# 发布与更新准则

所有 App、浏览器插件、远程页面的发布和更新都必须遵守本文档。

---

## 一、版本号规范

所有组件统一使用 **语义化版本号** `major.minor.patch`（如 `1.0.2`）。

### 9 进制版本规则（App 版本递增约定）

**patch 与 minor 最大到 9，到 9 后进位**，不允许出现 `0.7.10`、`0.9.10` 这类超过 9 的版本号：

| 当前版本 | 下一个版本 | 说明 |
|---------|-----------|------|
| `0.7.9` → | `0.8.0` | patch 到 9 → minor +1，patch 归 0 |
| `0.9.9` → | `1.0.0` | minor 到 9 → major +1，minor/patch 归 0 |
| `0.8.5` → | `0.8.6` | patch < 9 → 正常 +1 |

⚠️ 禁止 `npm version patch` 自动递增（会产生 `0.7.10` 这类违规版本）。必须手动指定目标版本号。

> 说明：底层版本比较始终用数字语义比较（`versionUtils.compareSemver` 按 major/minor/patch 数值比较），所以 `0.7.10 > 0.7.9` 技术上也能正确识别更新；9 进制规则是为了保持版本号可读性和后续自动化工具的一致性。

### App 版本号（单一来源）

App 版本号**唯一来源**是 `package.json` → `version`，构建时固化到二进制中。

- 运行时通过 `app.getVersion()` 读取，用于：侧边栏显示、更新页面显示、更新对比
- **不需要**任何运行时版本文件（`app-version.json` 已废弃）
- 只需修改 `package.json` 一处，全局生效

### 浏览器插件版本号（2 处）

| 位置 | 发布前必须检查 |
|------|--------------|
| `publish-extension/chrome-extension/manifest.json` → `version` | ✅ |
| `publish-extension/chrome-extension/popup/popup.html` → `mini-version` | ✅ |

### 远程页面版本号

| 位置 | 说明 |
|------|------|
| `antbot-remote-ui` 仓库 `version.json` → `version` | 热更新对比用 |
| `src/main/services/remote-ui/index.html` 侧边栏 | 硬编码，随热更新替换 |

**规则：**
- 版本号必须递增，不允许回退
- 发布前必须手动检查所有版本号位置是否一致

---

## 二、App 发布

### 2.1 构建流程

**产物规则以 `docs/packaging.md` 为准**（mac 只打 `.app` 移动到项目根目录，win 只打 exe；不需要 dmg/zip）：

```bash
# 1. 升版本号（手动指定目标版本，按 9 进制规则，禁止 npm version patch）
npm version 0.8.0 --no-git-tag-version   # 示例：0.7.9 → 0.8.0（patch 到 9 进位）

# 2. 构建（build:mac 内部自动完成签名 + 复制到根目录）
npm run build:mac

# 3. 清理垃圾文件
find release/mac-arm64/搬运蚁.app -name '.DS_Store' -delete
find release/mac-arm64/搬运蚁.app -name '__MACOSX' -type d -exec rm -rf {} +
```

### 2.2 发布到 GitHub

**每次发布必须同时打包并上传两个平台产物**（mac zip + win exe），Assets 里必须有 mac 和 win 的版本 App：

```bash
# 1. 提交并打 tag
git add -A
git commit -m "v0.7.3: 更新说明"
git tag v0.7.3
git push origin main --tags

# 2. 创建 Release（必须同时上传 mac zip 和 win exe 两个资产）
ditto -c -k --sequesterRsrc --keepParent "./搬运蚁.app" "/tmp/antbot-macos-arm64.zip"
gh release create v0.7.3 \
  /tmp/antbot-macos-arm64.zip \
  "./AntBot-0.7.3-win-x64.exe" \
  --title "v0.7.3" \
  --notes "## v0.7.3\n\n### 修复\n- xxx\n### 新功能\n- xxx" \
  --repo cxcboss/AntBot
```

> 大文件上传（283MB mac zip + 214MB win exe）直接跑 `gh release upload` 会超时，改用后台 nohup 方式上传（见历史记录）。

### 2.3 注意事项

- 给用户交付的是项目根目录的 `搬运蚁.app`（本地测试/直接拷贝）；GitHub Release 的 zip 资产用于 App 内更新检测
- zip 文件名必须用 ASCII（`antbot-macos-arm64.zip`），中文文件名会导致 GitHub Release 资产名乱码
- 打包前必须清理 `__MACOSX` 和 `.DS_Store`
- 发布后恢复本地版本号为测试版本（`npm version 0.5.5 --no-git-tag-version`），以便测试更新功能；**发布版本以 git tag 为准**

### 2.4 更新检测原理

```
用户端 app.getVersion()（如 0.3.7）
        ↓ 对比
GitHub Release 最新 tag（如 v0.4.1 → 0.4.1）
        ↓
0.4.1 > 0.3.7 → 提示有更新
```

- 版本号在构建时固化到 .app 二进制中
- 安装新版 .app 后，`app.getVersion()` 自动返回新版本
- 无需手动维护任何运行时版本文件

---

## 三、浏览器插件发布

### 3.1 修改版本号（2 处）

```bash
# 1. manifest.json
# "version": "1.0.3"

# 2. popup.html
# <div class="mini-version">v1.0.3</div>
```

### 3.2 打包

```bash
# 只打包 chrome-extension 目录！不要打包整个 publish-extension
cd publish-extension
ditto -c -k --sequesterRsrc chrome-extension /tmp/browser-plugin.zip
```

### 3.3 发布

```bash
gh release create plugin-v1.0.3 /tmp/browser-plugin.zip \
  --title "浏览器插件 v1.0.3" \
  --notes "## 浏览器插件 v1.0.3\n\n### 改进\n- xxx" \
  --repo cxcboss/AntBot
```

### 3.4 插件更新检测原理

```
本地 ~/AntBot/browser-plugin/version.json（如 1.0.2）
        ↓ 对比
GitHub Release 最新 plugin- tag（如 plugin-v1.0.3 → 1.0.3）
        ↓
1.0.3 > 1.0.2 → 提示有更新
```

- 插件版本由 `installPluginUpdate()` 自动写入 `~/AntBot/browser-plugin/version.json`
- 用户从 `~/AntBot/browser-plugin/chrome-extension/` 加载扩展到 Chrome

---

## 四、远程页面热更新

### 4.1 仓库

- GitHub: `cxcboss/antbot-remote-ui`
- 本地克隆: `/tmp/antbot-remote-ui/`

### 4.2 修改文件

```bash
# 1. 复制最新的远程页面
cp src/main/services/remote-ui/index.html /tmp/antbot-remote-ui/remote-ui/index.html

# 2. 提取 Hub 页面 HTML（从 Worker 源码中的 HTML 常量）
node -e "
const fs = require('fs');
const src = fs.readFileSync('workers/antbot-hub/src/index.js', 'utf-8');
const match = src.match(/const HTML = \x60([\s\S]*?)\x60;/);
if (match) fs.writeFileSync('/tmp/antbot-remote-ui/hub/index.html', match[1]);
"
```

### 4.3 更新版本号

```bash
# 编辑 /tmp/antbot-remote-ui/version.json
{
  "version": "1.0.4",
  "publishedAt": "2026-07-29T00:00:00Z",
  "files": {
    "remote-ui/index.html": {},
    "hub/index.html": {}
  }
}
```

### 4.4 推送

```bash
cd /tmp/antbot-remote-ui
git add -A
git commit -m "v1.0.4: 描述修改内容"
git push origin main
```

### 4.5 远程页面更新检测原理

```
本地 ~/AntBot/remote-ui/version.json（如 1.0.3）
        ↓ 对比
GitHub raw version.json（如 1.0.4）
        ↓
1.0.4 > 1.0.3 → 下载新文件并替换
```

- App 启动时自动检查，有更新则下载
- 下载完成后自动推送 Hub HTML 到 Cloudflare Worker KV
- 远程控制服务器优先从 `~/AntBot/remote-ui/` 加载页面

---

## 五、打包前检查清单

### 通用检查
- [ ] 所有版本号已更新且一致
- [ ] 没有 `.DS_Store` 文件
- [ ] 没有 `__MACOSX` 目录
- [ ] zip 文件名使用 ASCII

### App 专属
- [ ] `package.json` 版本号已更新（**唯一需要改的地方**）
- [ ] 构建完成已自动签名并复制到项目根目录（`./搬运蚁.app`）
- [ ] 构建前删除项目根目录的旧 `搬运蚁.app`

### 浏览器插件专属
- [ ] `manifest.json` 版本号已更新
- [ ] `popup.html` 版本号已更新
- [ ] 只打包 `chrome-extension/` 目录
- [ ] zip 大小合理（< 100KB）

### 远程页面专属
- [ ] `version.json` 版本号已更新
- [ ] `remote-ui/index.html` 已复制到仓库
- [ ] 如果修改了 Hub Worker HTML → 需要 `wrangler deploy`

---

## 六、版本号统一架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  package.json│     │  manifest.json│     │  version.json│
│   (App)      │     │  (插件)       │     │  (远程页面)   │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                     │
  构建时固化            构建时打包           热更新下载
       │                    │                     │
       ▼                    ▼                     ▼
  app.getVersion()    ~/AntBot/browser-    ~/AntBot/remote-
  → 侧边栏显示         plugin/version.json   ui/version.json
  → 更新页面显示        → 更新检测            → 更新检测
  → 更新对比
```

**App 版本号是单一来源**：`package.json` → 构建时固化 → `app.getVersion()` 运行时读取。
不需要任何运行时版本文件，不会出现版本不一致的问题。
