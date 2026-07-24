# 视频发布功能开发记录

## 日期：2026-07-24

## 功能概述

将外部仓库 `video-publish-extension` 对接进蚁 app，实现：在蚁 app 发布页选择视频 → 通过默认浏览器中的 Chrome 插件自动发布到抖音/视频号。

## 架构

```
蚁 app 发布页 (Electron)
    ↓ IPC (publish:start)
蚁 app 主进程 (ipc.js → browserPublishBridge.js)
    ↓ HTTP POST /api/bridge/commands
搬运蚁发布助手桥接服务 (local-server/server.js, port 3000)
    ↓ 轮询 GET /api/bridge/commands/next
Chrome 插件 background.js (800ms 轮询)
    ↓ chrome.tabs.sendMessage
Chrome 插件 content scripts (douyin.js / weixin.js)
    ↓ 自动上传、填写表单、点击发布
    ↓ POST /api/bridge/commands/:id/result 回传结果
蚁 app 接收结果 → 渲染到发布页
```

## 涉及的仓库/分支

- **蚁 app 主目录**: `/Users/chenxincheng/Desktop/my/Develop/Claude/AntBot` (main 分支)
- **浏览器插件仓库**: `https://github.com/cxcboss/video-publish-extension.git`
  - 本地副本: `/Users/chenxincheng/Desktop/my/Develop/Claude/AntBot/publish-extension/`

## 蚁 app 新增/修改的文件

### 新增文件
- `src/main/services/bridgeQueue.js` — 桥接命令队列（纯内存，可测试）
- `src/main/services/browserPublishBridge.js` — 桥接客户端（HTTP 调用插件服务）
- `src/main/services/tests/browserPublishBridge.test.js` — 桥接客户端测试

### 修改文件
- `src/main/ipc.js` — 新增 IPC: `publish:bridge-status`, `publish:bridge-capabilities`, `publish:start`, `publish:stop`
- `src/main/preload.js` — 新增 preload 方法: `publishBridgeStatus`, `publishBridgeCapabilities`, `publishStart`, `publishStop`, `onPublishProgress`
- `src/main/services/config.js` — 默认设置新增 `publish.browserExtension` 配置
- `src/main/services/publisher.js` — `publishVideo()` 优先走浏览器插件桥接，失败回退 Playwright
- `src/renderer/index.html` — `#view-publish` 从占位符改为完整发布页
- `src/renderer/style.css` — 新增 `.publish-layout` 系列样式
- `src/renderer/app.js` — 新增 `bindPublishPage()` 函数

## 浏览器插件修改

### 改名
- `manifest.json`: "AI 视频发布助手" → "搬运蚁发布助手"
- `popup.html`: 标题同步改名
- 全仓库品牌名统一为"搬运蚁发布助手"

### 桥接功能
- `background.js` — 新增：
  - `BRIDGE_BASE_URL = http://localhost:3000`
  - `bridgeRequest()`, `bridgeEvent()`, `bridgeResult()`
  - `handleBridgeCommand()` — 处理 publish.start / publish.stop / publish.getState / browser.*
  - `pollBridgeCommands()` — 800ms 轮询命令队列
  - `executeBrowserCommand()` — 通用浏览器控制（getState/click/type/select/scroll/eval/screenshot）
  - `startBridgePolling()` — 启动时自动开始轮询
  - `bridgeCommandId` — 跟踪当前发布命令 ID，完成后回传结果

- `content/douyin.js` — 支持 `video.path` 直传，支持 `settings.publishCopy` / `settings.publishTopics` / `settings.isOriginal`
- `content/weixin.js` — 同上

### 桥接服务
- `local-server/server.js` — 新增桥接 HTTP 端点:
  - `GET /api/bridge/status` — 连接状态
  - `GET /api/bridge/capabilities` — 能力列表
  - `POST /api/bridge/commands` — 入队命令
  - `GET /api/bridge/commands/next` — 取下一条（插件轮询）
  - `GET /api/bridge/commands/:id` — 查询命令+事件
  - `POST /api/bridge/commands/:id/events` — 插件回传进度
  - `POST /api/bridge/commands/:id/result` — 插件回传结果
  - `POST /api/bridge/commands/:id/cancel` — 取消

- `local-server/bridgeQueue.js` — 新增桥接队列模块
- `local-server/tests/bridgeQueue.test.js` — 队列测试

### Windows 打包同步
- `win_app/assets/` 下所有 chrome-extension 和 local-server 文件已同步
- `win_app/pubspec.yaml` 新增 `bridgeQueue.js`
- `win_app/lib/main.dart` 资源列表新增 `bridgeQueue.js`

## 支持的桥接命令

| 命令 | 说明 |
|------|------|
| `publish.start` | 开始发布（传入 videos, settings, videoPath, platform） |
| `publish.stop` | 停止发布 |
| `publish.getState` | 读取插件当前发布状态 |
| `browser.getState` | 获取当前页面 DOM 状态 |
| `browser.getTabs` | 获取所有标签页 |
| `browser.navigate` | 导航到 URL |
| `browser.click` | 点击元素 |
| `browser.type` | 输入文字 |
| `browser.select` | 选择下拉框 |
| `browser.scroll` | 滚动页面 |
| `browser.screenshot` | 截图 |
| `browser.eval` | 执行 JS |

## 蚁 app 发布页 UI

- 左侧栏点击"发布"切换到发布页
- 顶部状态栏显示"插件已连接 / 插件未连接"（每 3 秒轮询）
- 选视频（系统文件选择器）
- 选平台（视频号 / 抖音）
- 文案、话题、定时发布、原创声明
- "通过浏览器发布"按钮
- "停止发布"按钮

## 配置项

```js
// src/main/services/config.js
publish: {
  platform: '视频号',
  enabled: true,
  browserExtension: {
    enabled: true,          // 是否走浏览器插件
    baseUrl: 'http://127.0.0.1:3000',
    fallbackToPlaywright: true,  // 插件不可用时回退 Playwright
    timeoutMs: 30 * 60 * 1000
  }
}
```

## 使用流程

1. Chrome 安装插件: `publish-extension/chrome-extension/`
2. 启动桥接服务: `cd publish-extension/local-server && node server.js`
3. 蚁 app 打开 → 点击"发布" → 选视频 → 选平台 → 点"通过浏览器发布"
4. 插件自动打开发布页 → 上传视频 → 填表单 → 点发布 → 回传结果

## 注意事项

- `publish-extension/` 整个目录已提交到 main 分支的 git
- 浏览器插件桥接服务和蚁 app 内部 API 都在同一端口 3000（插件侧），蚁 app 自己的 API 在 18930
- 插件 content scripts 固定请求 `http://localhost:3000` 获取视频文件
- 发布页不依赖登录状态，但实际发布需要在 Chrome 中登录抖音/视频号
