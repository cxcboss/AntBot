# 搬运蚁飞牛中转 app

这个目录是飞牛 fnOS 的 Docker 应用包源码。它不直接运行桌面自动化，而是做一层 NAS 中转：

- 手机访问飞牛 NAS 上的这个 app
- app 把 `/api/*` 请求转发到同局域网里的搬运蚁桌面端
- 网页端 UI 直接复用 `src/remote`

首次使用：

1. 先在 Mac 桌面端开启远程访问，记下局域网地址，例如 `http://192.168.31.8:17888`
2. 安装并打开飞牛 app
3. 第一次会自动进入 `/setup/`
4. 填入上面的桌面端地址并保存
5. 之后手机和外网访问 NAS 时，就会进入聊天式远程控制页面

本地打包：

```bash
bash ./scripts/build-fnos-relay-app.sh
```

产物输出到 `release_fnos_app/`。

说明：

- Docker 基础镜像改为华为云 SWR 的 Docker Hub 镜像源，避免部分 fnOS 环境在拉取 `docker.io/library/node:22-alpine` 时出现 `401 Unauthorized`。
