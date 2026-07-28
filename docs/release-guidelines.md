# 发布与更新准则

所有 App、浏览器插件、远程页面的发布和更新都必须遵守本文档。

---

## 一、版本号规范

所有组件统一使用 **语义化版本号** `major.minor.patch`（如 `1.0.2`）。

| 组件 | 版本号位置 | 发布前必须检查 |
|------|-----------|--------------|
| App | `package.json` → `version` | ✅ |
| App | `~/AntBot/app-version.json` → `version` | 自动写入 |
| 浏览器插件 | `publish-extension/chrome-extension/manifest.json` → `version` | ✅ |
| 浏览器插件 | `publish-extension/chrome-extension/popup/popup.html` → `mini-version` | ✅ |
| 浏览器插件 | `~/AntBot/browser-plugin/version.json` → `version` | 自动写入 |
| 远程页面 | `antbot-remote-ui` 仓库 `version.json` → `version` | ✅ |
| 远程页面 | `~/AntBot/remote-ui/version.json` → `version` | 自动写入 |

**规则：**
- 版本号必须递增，不允许回退
- 发布前必须手动检查所有版本号位置是否一致
- 插件版本号有 3 处需要手动改（manifest、popup.html、version.json），漏改会导致 UI 显示不一致

---

## 二、App 发布

### 2.1 构建流程

```bash
# 1. 升版本号
npm version 0.4.1 --no-git-tag-version

# 2. 构建
npm run build:mac

# 3. 清理垃圾文件
rm -rf release/mac-arm64/搬运蚁.app/.DS_Store
find release/mac-arm64/搬运蚁.app -name '__MACOSX' -type d -exec rm -rf {} +
find release/mac-arm64/搬运蚁.app -name '.DS_Store' -delete
xattr -cr release/mac-arm64/

# 4. 签名
codesign --force --deep --sign - release/mac-arm64/搬运蚁.app

# 5. 打包 zip（使用 ASCII 文件名）
cd release/mac-arm64
ditto -c -k --sequesterRsrc --keepParent "搬运蚁.app" "/tmp/antbot-macos-arm64.zip"
```

### 2.2 发布到 GitHub

```bash
# 1. 提交并打 tag
git add -A
git commit -m "v0.4.1: 更新说明"
git tag v0.4.1
git push origin main --tags

# 2. 创建 Release
gh release create v0.4.1 /tmp/antbot-macos-arm64.zip \
  --title "v0.4.1" \
  --notes "## v0.4.1\n\n### 修复\n- xxx\n### 新功能\n- xxx" \
  --repo cxcboss/AntBot
```

### 2.3 注意事项

- zip 文件名必须用 ASCII（`antbot-macos-arm64.zip`），中文文件名会导致 GitHub Release 资产名乱码
- 打包前必须清理 `__MACOSX` 和 `.DS_Store`，这些是 macOS 系统垃圾文件
- 发布后必须恢复本地版本号为测试版本（`npm version 0.3.7 --no-git-tag-version`），以便测试更新功能
- `~/AntBot/app-version.json` 会由 app 启动时自动同步（如果二进制版本更新则写入），无需手动修改

---

## 三、浏览器插件发布

### 3.1 修改版本号（3 处）

```bash
# 1. manifest.json
# "version": "1.0.3"

# 2. popup.html
# <div class="mini-version">v1.0.3</div>

# 3. 版本号必须三处一致
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

### 3.4 注意事项

- **只打包 `chrome-extension/` 目录**，不要打包 `local-server/`、`mac-app/`、`shared/` 等无关文件
- 不要包含 `.DS_Store`、`__MACOSX`、`.git` 等系统文件
- zip 应该很小（约 60KB），如果超过 100KB 说明打包了多余文件
- 插件通过 HTTP `http://127.0.0.1:18321` 和桥接服务通信，不需要其他文件
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

### 4.5 自动更新链路

- App 启动时自动检查 `version.json`，有更新则下载
- 下载完成后自动推送 Hub HTML 到 Cloudflare Worker KV
- 远程控制服务器优先从 `~/AntBot/remote-ui/` 加载页面

---

## 五、打包前检查清单

每次发布任何组件前，必须逐项检查：

### 通用检查
- [ ] 所有版本号已更新且一致
- [ ] 没有 `.DS_Store` 文件
- [ ] 没有 `__MACOSX` 目录
- [ ] 没有 `.git` 目录
- [ ] 没有 `node_modules` 目录
- [ ] zip 文件名使用 ASCII

### App 专属
- [ ] `package.json` 版本号已更新
- [ ] 构建完成后签名（`codesign`）
- [ ] 构建前删除项目根目录的旧 `搬运蚁.app`（避免 resource fork 错误）
- [ ] 发布后恢复本地版本号为测试版本

### 浏览器插件专属
- [ ] `manifest.json` 版本号已更新
- [ ] `popup.html` 版本号已更新
- [ ] 只打包 `chrome-extension/` 目录
- [ ] zip 大小合理（< 100KB）

### 远程页面专属
- [ ] `version.json` 版本号已更新
- [ ] `remote-ui/index.html` 已复制到仓库
- [ ] `hub/index.html` 已从 Worker 源码提取并复制
- [ ] 如果修改了 Hub Worker HTML → 需要 `wrangler deploy`

---

## 六、Hub Worker 部署

当修改了 Hub Worker 代码（`workers/antbot-hub/src/index.js`）时：

```bash
CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy \
  --config workers/antbot-hub/wrangler.toml
```

- Worker 部署到 `hub.onebugmanai.online`
- KV 命名空间: `DEVICES`
- Hub HTML 通过 KV 缓存热更新（无需重新部署 Worker）

---

## 七、常见错误

| 错误 | 原因 | 修复 |
|------|------|------|
| 插件 Chrome 显示版本 0.0.4，更新系统显示 1.0.1 | manifest.json 版本号没改 | 发布前检查 3 处版本号 |
| App 更新下载很慢/超时 | curl 走代理或 Node.js 不走代理 | 使用原生 HTTP + 系统代理检测 |
| App 更新后还是旧版本 | 更新脚本硬编码了 `/Applications/` | 改为自动检测当前 App 路径 |
| zip 解压后多了 `__MACOSX` 目录 | macOS 的 ditto 打包时自动生成 | 打包前删除，解压后自动清理 |
| GitHub Release 资产名乱码 | zip 文件名含中文 | 使用 ASCII 文件名 |
| 重复下载 App 更新 | 本地版本号没更新 | 安装成功后自动写入新版本号 |
| 浏览器插件 zip 1.7MB | 打包了整个 publish-extension | 只打包 chrome-extension/ |
