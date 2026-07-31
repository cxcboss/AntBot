# 搬运蚁发布助手

AI 驱动的浏览器扩展 + 桌面管理工具，支持自动发布视频到抖音和视频号平台。

## 功能特性

- **双平台发布** — 抖音、视频号一键发布
- **AI 智能生成** — 根据视频内容自动生成话题标签和描述文案
- **多 AI Provider** — 小米 MiMo、OpenAI、Gemini、豆包、DeepSeek
- **定时发布** — 抖音原生定时发布，视频号自动延时
- **批量发布** — 目录自动加载，拖拽排序，队列发布
- **星图任务** — 抖音小游戏自动关联星图任务
- **超时重试** — 单个视频发布超时自动重试

## 项目结构

```
video-publish-extension/
├── chrome-extension/          # Chrome 浏览器扩展
│   ├── manifest.json
│   ├── popup/                 # 弹窗 UI（发布控制面板）
│   ├── background/            # 后台服务（AI 调用、发布流程）
│   ├── content/               # 页面自动化脚本
│   │   ├── douyin.js          # 抖音创作者平台
│   │   └── weixin.js          # 视频号发布平台
│   └── icons/
├── local-server/              # Node.js 本地服务（由 Electron 主 App 启动）
│   ├── server.js              # Express，视频文件读取 + 发布桥接
│   └── package.json
└── .github/                   # 插件仓库 CI/CD 配置
```

## 快速开始

### 方式一：通过搬运蚁 App（推荐）

1. 在 Chrome 扩展管理页开启开发者模式
2. 选择「加载已解压的扩展程序」，指向 `chrome-extension/`
3. 启动搬运蚁 App，在发布页启动桥接服务
4. 保持 Chrome 扩展启用，通过搬运蚁发布页提交任务

### 方式二：独立调试

```bash
# 1. 启动本地服务
cd local-server && npm install && node server.js

# 2. Chrome 加载扩展
#    chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 chrome-extension/
```

## AI 配置

扩展内点击「AI 配置」展开设置：

| Provider | 端点 | 默认模型 |
|----------|------|----------|
| 小米 MiMo | `api.xiaomimimo.com` | mimo-v2.5 |
| OpenAI | `api.openai.com` | gpt-4o-mini |
| Gemini | `generativelanguage.googleapis.com` | gemini-2.0-flash |
| 豆包 | `ark.cn-beijing.volces.com` | doubao-seed-2-0-mini |
| DeepSeek | `api.deepseek.com` | deepseek-chat |

## 文件命名规则

| 格式 | 行为 |
|------|------|
| `游戏名-视频描述.mp4` | AI 生成文案 |
| `123-xxx.mp4` | 跳过 AI，使用默认话题 |
| `小游戏-任务名.mp4` | 抖音自动关联星图任务 |
| `原创-xxx.mp4` | 跳过活动选择 |

## DOM 元素参考

### 抖音创作者平台

| 元素 | 选择器 |
|------|--------|
| 上传入口 | `input[type="file"][accept*="video"]` |
| 主编辑器 | `[contenteditable="true"]`，排除"话题/tag"，取面积最大 |
| 话题输入框 | `[contenteditable="true"]`，placeholder 含"话题/tag/#" |
| 定时发布 | 文本"定时发布"，向上遍历找 switch/button |
| 日期时间 | `input[placeholder*="日期"]`，格式 `YYYY-MM-DD HH:MM` |
| 发布按钮 | `button` 文本"发布"/"发表" |
| 星图任务按钮 | 文本"请选择星图任务"，需先滚动页面触发懒加载 |

### 视频号（wujie shadow DOM）

| 元素 | 选择器 |
|------|--------|
| shadow 根 | `document.querySelector('wujie-app').shadowRoot` |
| 活动按钮 | `.activity-display-wrap`，默认"不参与活动" |
| 活动搜索 | `.activity-filter-wrap` 内的 input |
| 活动选项 | `.activity-item` / `.option-item` → `SPAN.name` |
| 发布按钮 | shadow 内 `button` 文本"发表" |

## 本地服务 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/api/videos?path=` | 视频列表 |
| GET | `/api/video/file?path=` | 视频文件（Range） |
| GET | `/api/directories?path=` | 子目录列表 |
| GET | `/api/publish-history` | 发布历史 |
| POST | `/api/publish-record` | 新增记录 |
| DELETE | `/api/publish-record/:id` | 删除记录 |

## 许可证

MIT License
