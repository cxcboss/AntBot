# AntBot API 操作文档

> 供 AI 助手直接操控 AntBot 应用的 HTTP API 接口文档

## 连接信息

```
基础地址: http://127.0.0.1:18930
协议: HTTP/JSON
认证: 无（仅本地访问）
```

所有请求和响应均为 JSON 格式。成功响应结构：`{ ok: true, ...data }`，失败：`{ ok: false, message: "..." }`。

---

## 1. 健康检查

```
GET /api/health
```

**响应：**
```json
{ "ok": true, "version": "0.7.2" }
```

用于确认 App 已启动且 API 服务可用。

---

## 2. 查看完整状态

```
GET /api/status
```

**响应：**
```json
{
  "ok": true,
  "version": "0.7.2",
  "dataDir": "/Users/xxx/AntBot",
  "tasks": [
    {
      "id": "ev-1234",
      "name": "23256.mp4",
      "status": "preparing",
      "progress": 35,
      "step": "AI识别",
      "error": "",
      "outputPath": ""
    }
  ],
  "recentLogs": ["app-2026-07-21T10-30-00.log", ...],
  "settings": {
    "apiBaseUrl": "https://apihub.agnes-ai.com/v1",
    "hasApiKeys": true,
    "frameRate": 1,
    "outputDir": "/Users/xxx/Desktop/视频"
  }
}
```

**用途：** 快速了解 App 当前状态、正在执行的任务、配置是否正确。

---

## 3. 查看日志

```
GET /api/logs?count=1
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| count | number | 1 | 返回最近几个日志文件 |

**响应：**
```json
{
  "ok": true,
  "logs": [
    {
      "filename": "app-2026-07-21T10-30-00.log",
      "content": "[2026-07-21T10:30:00.000Z] [info] ═══ AntBot 启动 ═══\n..."
    }
  ]
}
```

**用途：** 排查错误、查看详细运行信息。

---

## 4. 剪辑任务管理

### 4.1 添加并启动任务

```
POST /api/edit/start
Content-Type: application/json

{
  "videoPath": "/Users/xxx/Downloads/video.mp4",
  "name": "视频名称",
  "style": "开车解说",
  "voice": "猴哥Pro",
  "subtitle": "开启",
  "outputDir": "/Users/xxx/Desktop/视频",
  "frameRate": 1
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| videoPath | 是 | 视频文件完整路径 |
| name | 否 | 任务名（默认取文件名） |
| style | 否 | 风格名（对应已学习的风格参考） |
| voice | 否 | 音色名（对应已克隆的音色） |
| subtitle | 否 | "开启" 或 "关闭"，默认"开启" |
| outputDir | 否 | 输出目录（默认用设置里的） |
| frameRate | 否 | 抽帧频率：1=1秒/帧，0.5=2帧/秒，3=3秒/帧 |

**响应：**
```json
{
  "ok": true,
  "task": { "id": "api-1234567890", "name": "video.mp4", "status": "pending", ... }
}
```

添加后自动开始处理。

### 4.2 查看所有任务

```
GET /api/edit-tasks
```

**响应：** 任务数组，每个任务包含完整状态（id、name、status、progress、step、error、outputPath 等）。

任务状态：`pending` → `preparing` → `ready` → `composing` → `completed`，或 `failed` / `paused` / `cancelled`。

### 4.3 启动所有待处理任务

```
POST /api/edit/start-all
```

将所有 `pending` 和 `paused` 状态的任务加入执行队列。

### 4.4 暂停任务

```
POST /api/edit/pause
Content-Type: application/json

{ "taskId": "api-1234567890" }
```

暂停正在准备阶段的任务。合成阶段的任务无法暂停。

### 4.5 取消任务

```
POST /api/edit/cancel
Content-Type: application/json

{ "taskId": "api-1234567890" }
```

取消任务并清理产生的临时文件。

### 4.6 移除任务

```
POST /api/edit/remove
Content-Type: application/json

{ "taskId": "api-1234567890" }
```

从列表中移除任务（运行中的先取消再移除）。

---

## 5. 剪辑历史

```
GET /api/edit-history
```

**响应：**
```json
{
  "ok": true,
  "history": [
    {
      "id": "hist-1234",
      "name": "video.mp4",
      "sourcePath": "/原始路径",
      "outputPath": "/输出路径",
      "status": "completed",
      "style": "开车解说",
      "voice": "猴哥Pro",
      "duration": 120,
      "createdAt": "2026-07-21T10:30:00.000Z"
    }
  ]
}
```

---

## 6. 设置管理

### 6.1 读取设置

```
GET /api/settings
```

返回完整设置对象（API keys、路径、样式、语音克隆配置等）。

### 6.2 更新设置

```
POST /api/settings
Content-Type: application/json

{
  "api": {
    "apiKeys": ["key1", "key2"],
    "baseUrl": "https://apihub.agnes-ai.com/v1",
    "modelId": "agnes-2.0-flash"
  },
  "edit": {
    "frameRate": 1
  },
  "paths": {
    "outputBaseDir": "/Users/xxx/Desktop/视频"
  }
}
```

支持部分更新，只需传要修改的字段。

---

## 7. 音色列表

```
GET /api/voices
```

**响应：**
```json
{
  "ok": true,
  "voices": [
    { "id": "fb4e23e7-...", "name": "猴哥Pro" },
    { "id": "a1b2c3d4-...", "name": "猪妞" }
  ]
}
```

---

## 典型操作流程

### 一次性剪辑一个视频

```bash
# 1. 检查状态
curl -s http://127.0.0.1:18930/api/status | python3 -m json.tool

# 2. 启动剪辑
curl -s -X POST http://127.0.0.1:18930/api/edit/start \
  -H "Content-Type: application/json" \
  -d '{"videoPath":"/Users/xxx/Downloads/video.mp4","style":"开车解说","voice":"猴哥Pro"}'

# 3. 轮询进度（每30秒）
curl -s http://127.0.0.1:18930/api/edit-tasks

# 4. 完成后查看历史
curl -s http://127.0.0.1:18930/api/edit-history
```

### 批量剪辑多个视频

```bash
# 逐个添加任务（自动排队执行）
curl -s -X POST http://127.0.0.1:18930/api/edit/start \
  -H "Content-Type: application/json" \
  -d '{"videoPath":"/path/to/video1.mp4","style":"解说","voice":"猴哥"}'

curl -s -X POST http://127.0.0.1:18930/api/edit/start \
  -H "Content-Type: application/json" \
  -d '{"videoPath":"/path/to/video2.mp4","style":"解说","voice":"猪妞"}'
```

### 出错时查看日志

```bash
curl -s "http://127.0.0.1:18930/api/logs?count=1" | python3 -c "import sys,json; print(json.load(sys.stdin)['logs'][0]['content'])"
```

### 更新 API Key

```bash
curl -s -X POST http://127.0.0.1:18930/api/settings \
  -H "Content-Type: application/json" \
  -d '{"api":{"apiKeys":["new-key-1","new-key-2"]}}'
```

### 修改抽帧频率

```bash
curl -s -X POST http://127.0.0.1:18930/api/settings \
  -H "Content-Type: application/json" \
  -d '{"edit":{"frameRate":0.5}}'
```
