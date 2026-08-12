# publisher.js — 视频发布（浏览器插件桥接 + Playwright 回退）

> 路径：`src/main/services/publisher.js`、`browserPublishBridge.js`、`bridgeQueue.js`

## 职责

将剪辑完成的视频发布到抖音/视频号。**优先走浏览器插件桥接**，插件不可用时回退 Playwright。

## 架构

```
蚁 app 发布页 (Electron)
    ↓ IPC (publish:start)
蚁 app 主进程 (ipc/publish.js → browserPublishBridge.js)
    ↓ HTTP POST /api/bridge/commands
搬运蚁发布助手桥接服务 (publish-extension/local-server/server.js, port 18321)
    ↓ 轮询 GET /api/bridge/commands/next
Chrome 插件 background.js (800ms 轮询)
    ↓ chrome.tabs.sendMessage
Chrome 插件 content scripts (douyin.js / weixin.js)
    ↓ 自动上传、填写表单、点击发布
    ↓ POST /api/bridge/commands/:id/result 回传结果
蚁 app 接收结果 → 渲染到发布页
```

## 端口

| 服务 | 端口 | 说明 |
|------|------|------|
| 桥接服务（local-server） | **18321** | 插件轮询、App 发命令（`publish-extension/local-server/server.js` 中 `PORT`） |
| App 本地 API（apiServer） | 18930 | App 内部 HTTP API（docs/API.md） |

> ⚠️ 桥接端口是 **18321**，不是 3000（历史文档曾误写 3000）。

## 关键模块

| 模块 | 职责 |
|------|------|
| `publisher.js` | `publishVideo()` — 优先走桥接，失败回退 Playwright；发布超时 60 秒 |
| `browserPublishBridge.js` | 桥接客户端（HTTP 调用插件服务） |
| `bridgeQueue.js` | 桥接命令队列（纯内存，可测试） |
| `local-server/server.js` | 桥接服务（Express），由 `bridgeServiceManager.js` 管理生命周期 |
| `local-server/bridgeQueue.js` | 桥接服务侧命令队列 |

## 桥接命令

| 命令 | 说明 |
|------|------|
| `publish.start` | 开始发布（传入 videos, settings, videoPath, platform） |
| `publish.stop` | 停止发布 |
| `publish.getState` | 读取插件当前发布状态 |
| `browser.getState` / `getTabs` | 获取页面/标签状态 |
| `browser.navigate` | 导航到 URL |
| `browser.click` / `type` / `select` / `scroll` | 页面操作 |
| `browser.screenshot` / `eval` | 截图 / 执行 JS |

## 桥接服务端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/bridge/status` | 连接状态 |
| GET | `/api/bridge/capabilities` | 能力列表 |
| POST | `/api/bridge/commands` | 入队命令 |
| GET | `/api/bridge/commands/next` | 取下一条（插件轮询） |
| GET | `/api/bridge/commands/:id` | 查询命令+事件 |
| POST | `/api/bridge/commands/:id/events` | 插件回传进度 |
| POST | `/api/bridge/commands/:id/result` | 插件回传结果 |
| POST | `/api/bridge/commands/:id/cancel` | 取消 |

## 配置

```js
// src/main/services/config.js
publish: {
  platform: '视频号',
  enabled: true,
  browserExtension: {
    enabled: true,             // 是否走浏览器插件
    baseUrl: 'http://127.0.0.1:18321',
    fallbackToPlaywright: true,   // 插件不可用时回退 Playwright
    timeoutMs: 30 * 60 * 1000
  }
}
```

## 注意事项

- **MV3 Service Worker 保活**：插件用端口保活（25秒自连）+ `chrome.alarms` 兜底（1分钟唤醒），防止轮询中断
- App 不检查 `extensionConnected`，只检查桥接端口就绪即发送命令
- 插件 content scripts 固定请求 `http://localhost:18321` 获取视频文件
- 发布页不依赖登录状态，但实际发布需要在 Chrome 中登录抖音/视频号
- 插件更新检测：`~/AntBot/browser-plugin/version.json` vs GitHub Release `plugin-v*` tag
