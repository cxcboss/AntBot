# dependencyInstaller.js — 逐包 pip 安装模块

> 路径：`src/main/services/dependencyInstaller.js`

## 职责

逐个安装 Python pip 包，解析 stderr 获取下载进度/速度，支持取消。

## 稳定性

- pip 调用固定带 `--timeout 60 --retries 5`，网络抖动可自动重试
- 单包安装最长 60 分钟，超时强制终止（SIGTERM）并上报 `package-error`，避免 UI 无限等待

## 核心函数

| 函数 | 说明 |
|------|------|
| `parseRequirements(path)` | 解析 requirements.txt 为包列表 |
| `isPackageInstalled(venvPython, name)` | 检查包是否已安装 |
| `installSinglePackage(...)` | 安装单个包，带进度解析和取消 |
| `installDependencies({...})` | 逐包安装所有依赖，跳过已安装 |

## 进度解析

从 pip stderr 解析：
- `Collecting` → 开始下载
- `█████ 45%` → 百分比
- `1.2 MB/2.0 GB | 5.2 MB/s` → 大小和速度
- `Installing collected packages` → 正在安装
- `Successfully installed` → 完成

## 取消机制

每个包创建独立 AbortController，abort 后向 pip 子进程发 SIGTERM。

## 事件格式

```js
{ type: 'package-start|progress|done|error|cancelled', name, percent, speed, size, message }
```
