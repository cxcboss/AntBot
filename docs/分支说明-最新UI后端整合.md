# 最新 UI + 后端整合分支说明

本分支用于保留当前项目里可用的最新 Flutter UI 与后端源码的整合版本，便于后续继续开发、打包和交付。

## 分支信息

- 分支名：`codex/latest-ui-backend`
- 基线来源：`codex/Flutterhtml`
- 基线提交：`1dec6984ebaf747fae7eef91ddb8b61ec19d090a`

## 主要内容

- 最新 Flutter 前端 UI：`clients/antbot_flutter`
- Electron/Node 后端主程序：`src`
- fnOS relay 相关部署：`deploy/fnos-relay-app`
- 配套自动配音 Web 能力：`vendors/auto_dub_web`

## 说明

这条分支的目的不是保留临时打包产物，而是明确标记一条“最新 UI + 后端源码并存”的开发线。

如果后续继续做 Mac 打包，Flutter 桌面前端会从 `clients/antbot_flutter` 构建，后端能力则由 `src` 和 `vendors/auto_dub_web` 提供。
