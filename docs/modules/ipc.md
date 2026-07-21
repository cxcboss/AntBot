# ipc.js — IPC Handler 集中地

> 路径：`src/main/ipc.js`（~1100 行）

## 职责

所有 Electron IPC handler 的注册中心。包含：启动检查、设置管理、剪辑调度、语音克隆、voicebox 管理、模型管理、日志等。

## 核心模块

| 区域 | 行数范围 | 说明 |
|------|---------|------|
| App Logger | 8-45 | 按启动分文件日志，7天自动清理 |
| 窗口/状态 | 47-130 | 窗口状态推送、设置更新 |
| 登录/Auth | 131-210 | Playwright 登录窗口管理 |
| 任务 | 210-250 | 主任务（下载/字幕/发布）的 start/stop |
| 剪辑调度器 | 560-650 | EditScheduler 实例化、启动恢复清理和 IPC handler |
| voicebox 管理 | 350-560 | check/install/reset |
| 模型管理 | 560-700 | list/download/delete |
| 语音克隆 | 155-187 | voice:clone handler |
| 设置 | 90-130 | settings:update |

## 重要设计

- `appLog()` 函数全局可用，写入 `~/AntBot/logs/app-YYYY-MM-DDTHH-MM-SS.log`
- `mainWindowRef()` 获取主窗口引用，用于推送消息
- `store` 实例注入，通过 `registerIpcHandlers({ store, ... })`

## 对接

- 渲染进程通过 `preload.js` 调用
- 业务逻辑委托给各 services 模块
- 状态变更通过 `webContents.send()` 推送
- App 退出时调用 `editScheduler.shutdown()`，中断活动剪辑任务并清理其缓存
