# 多平台监控与处理动作实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 为桌面端和远程网页端增加 YouTube/TikTok 公开账号监控，并让每个监控按“仅下载、下载并剪辑、下载剪辑并发布”独立执行。

**Architecture:** 保留 monitorService → TaskRunner 主链路，把来源识别抽象成 YouTube/TikTok 适配分支，把处理动作作为任务快照字段传入现有任务流水线。桌面端继续使用 Electron IPC，远程端新增认证后的监控 HTTP API 和 SSE 更新；两端共用 ~/AntBot/monitors.json。

**Tech Stack:** Electron main process、Node.js、yt-dlp、现有 TaskRunner/smartEditor/publisher、原生 HTML/CSS/ES modules、Node node:test。

## Global Constraints

- 仅支持 YouTube 频道/用户主页和 TikTok 公开账号主页，不接入平台官方 API，不实现私密内容登录。
- 新监控默认 processMode 为 download；没有该字段的旧监控迁移为 publish，保持旧行为。
- 同一监控、同一平台、同一视频只能成功入队一次；只有入队成功后才更新 seenIds。
- 复用现有 TaskRunner，不复制下载、剪辑、发布实现；失败时保留已有视频产物和可恢复操作。
- 所有新增 CSS 使用设计 token，不使用渐变、硬编码阴影/圆角/过渡或已废弃 token。
- 修改远程页面时同步 src/main/services/remote-ui/index.html 与当前本地热更新缓存；不发布 GitHub 远程仓库。
- 打包前必须阅读并遵守 docs/packaging.md，版本号按 9 进制规则递增，macOS 只交付 arm64 .app。

---

### Task 1: 监控来源与配置模型

**Files:**
- Modify: src/main/services/monitorService.js
- Modify: src/main/ipc/monitor.js
- Modify: docs/modules/monitorService.md
- Create: src/main/services/tests/monitorService.test.js

**Interfaces:**
- Produces sourceType、processMode、平台化来源校验和标准视频对象，供 Task 2 与桌面/远程 UI 使用。
- Exposes pure helpers for tests: inferSourceType(sourceUrl)、normalizeProcessMode(value, isLegacy)、validateSourceUrl(sourceUrl, sourceType)、sourceVideoKey(sourceType, videoId)。

- [ ] Step 1: 写失败测试覆盖配置迁移、来源校验和去重键

~~~js
test('旧 YouTube 监控迁移为完整处理', () => {
  const migrated = migrateMonitor({ sourceUrl: 'https://www.youtube.com/@demo/videos' });
  assert.equal(migrated.sourceType, 'youtube');
  assert.equal(migrated.processMode, 'publish');
});

test('新监控默认只下载且 TikTok 使用平台前缀去重', () => {
  assert.equal(normalizeProcessMode('', false), 'download');
  assert.equal(sourceVideoKey('tiktok', 'abc'), 'tiktok:abc');
});

test('只接受公开账号主页', () => {
  assert.throws(() => validateSourceUrl('https://www.tiktok.com/video/123', 'tiktok'));
  assert.equal(inferSourceType('https://www.tiktok.com/@demo'), 'tiktok');
});
~~~

- [ ] Step 2: 运行测试确认当前实现失败

Run: node --test src/main/services/tests/monitorService.test.js

Expected: FAIL，因为当前服务只校验 YouTube，且没有 processMode/TikTok 规范化函数。

- [ ] Step 3: 实现配置迁移和平台校验

在 migrateMonitor 中补齐 sourceType 和 processMode。将 addMonitor、updateMonitor 的校验改为平台化 validateSourceUrl：YouTube 允许频道/用户主页及可选 /videos，TikTok 只允许 tiktok.com/@handle。新建数据缺少动作时使用 download，读取旧数据缺少动作时使用 publish。

- [ ] Step 4: 抽出来源视频标准化和平台化去重键

实现 normalizeSourceVideo(entry, sourceType)，统一生成 { id, title, url, webpageUrl, uploadDate, timestamp, duration, sourceType, key }，其中 key 为 sourceType + ':' + videoId。将 seenIds 读写统一改用 key，并兼容旧版裸 ID。

- [ ] Step 5: 让来源抓取按 sourceType 选择参数并保持互斥恢复

将 fetchChannelVideos 重命名为 fetchSourceVideos(sourceType, sourceUrl, limit = 10)。YouTube/TikTok 都使用 --flat-playlist -J --playlist-end 10 --skip-download --no-warnings，根据平台附加可用 cookies，保留现有超时和子进程错误处理。检查逻辑继续先建立首次基线，入队成功后才追加新 key。

- [ ] Step 6: 运行测试、更新文档并提交

Run: node --test src/main/services/tests/monitorService.test.js

Expected: PASS。同步 docs/modules/monitorService.md，写明两种平台、processMode 和旧数据迁移规则。

~~~bash
git add src/main/services/monitorService.js src/main/ipc/monitor.js docs/modules/monitorService.md src/main/services/tests/monitorService.test.js
git commit -m "feat: support youtube and tiktok monitor sources"
~~~

### Task 2: TaskRunner 三种处理动作

**Files:**
- Modify: src/main/taskRunner.js
- Modify: docs/modules/renderer-app.md
- Modify: src/main/services/monitorService.js

**Interfaces:**
- Consumes task field processMode: download | edit | publish。
- Produces stable outputPath、processMode、sourceType in progress rows、persisted entries and history items。

- [ ] Step 1: 增加动作阶段映射测试

在监控测试中验证 processStages('download') 为 ['download']，processStages('edit') 为 ['download', 'edit']，processStages('publish') 为 ['download', 'edit', 'publish']；非法值回退到 download。

- [ ] Step 2: 在 TaskRunner 中统一解析动作并传递来源字段

增加 resolveProcessMode(task) 和阶段标签；初始化 progress row、serializeTaskSnapshot、savePersistedTask、buildRunItem 时写入 processMode、sourceType、monitorId。普通桌面任务保持现有完整流程默认值。

- [ ] Step 3: 为仅下载动作提升稳定输出文件

下载成功后，针对 processMode === 'download' 将缓存文件复制到主控日期输出目录，使用安全任务名生成唯一 .mp4 路径；设置 completed/完成/下载完成/outputPath，跳过 prepare、compose 和 publish。缓存仍由原有清理流程负责。

- [ ] Step 4: 为下载并剪辑动作跳过发布

现有 prepareEditVideo → composeEditVideo 成功后，针对 processMode === 'edit' 直接写入完成状态和成品路径，不进入发布桥接；发布动作继续使用现有平台、重试和部分完成逻辑。

- [ ] Step 5: 修正发布模式的开关与失败语义

发布模式且全局发布关闭时，显示“成品已生成但未发布”，不记录虚假的已发布平台。发布失败保留 outputPath 并支持重新发布。所有模式的 run item 写入动作和来源信息。

- [ ] Step 6: 静态验证并提交

Run: node --check src/main/taskRunner.js && node --test src/main/services/tests/monitorService.test.js

Expected: 全部通过。更新 docs/modules/renderer-app.md 后提交：

~~~bash
git add src/main/taskRunner.js src/main/services/monitorService.js docs/modules/renderer-app.md src/main/services/tests/monitorService.test.js
git commit -m "feat: add monitor download and edit actions"
~~~

### Task 3: 远程监控 API 与状态推送

**Files:**
- Modify: src/main/services/remoteServer.js
- Modify: src/main/ipc/remote.js
- Modify: src/main/services/monitorService.js
- Modify: docs/remote-hot-update.md

**Interfaces:**
- Produces authenticated routes GET/POST/PATCH/DELETE /remote/monitors、POST /remote/monitors/:id/check 和 /toggle。
- Produces SSE event monitor-update containing { monitor, removed?, checking? }。

- [ ] Step 1: 增加远程监控路由

复用 authenticate、readBody 和 sendJson，映射到监控服务的增删改查/检查/启停函数；参数错误返回 400，未授权返回 401，不存在记录返回明确错误。

- [ ] Step 2: 建立监控服务到远程 SSE 的广播回调

给 monitorService.setContext 增加可选 monitorBroadcast；远程服务启动时注册 broadcast('monitor-update', payload)，服务未启动时安全忽略。桌面 IPC 更新和远程 SSE 使用同一份迁移对象。

- [ ] Step 3: 补齐远程状态摘要

/remote/monitors 返回完整列表，保留统计和错误字段，不返回本地敏感路径或凭证；保存、检查和启停后推送更新。

- [ ] Step 4: 静态验证并提交

Run: node --check src/main/services/remoteServer.js && node --check src/main/ipc/remote.js && node --check src/main/services/monitorService.js

~~~bash
git add src/main/services/remoteServer.js src/main/ipc/remote.js src/main/services/monitorService.js docs/remote-hot-update.md
git commit -m "feat: expose monitor controls to remote ui"
~~~

### Task 4: 桌面端监控页面交互

**Files:**
- Modify: src/renderer/index.html
- Modify: src/renderer/app/monitor-page.js
- Modify: src/renderer/style.css
- Modify: src/renderer/app.js

**Interfaces:**
- Consumes existing window.antbot.monitor* IPC methods and migrated monitor fields。
- Produces form payload { sourceType, sourceUrl, processMode, checkIntervalMinutes, overrides }。

- [ ] Step 1: 扩展监控弹窗结构

增加 YouTube/TikTok 来源切换、公开主页输入、三种处理动作选项卡和动作说明；保留频率与高级覆盖设置。来源切换时同步输入提示、示例和校验提示。

- [ ] Step 2: 更新页面表单状态

openDialog 读取 sourceType/processMode；collectForm 输出标准字段；旧数据缺字段时显示迁移后的值。保存、检查、切换和删除继续使用 loading/Toast，并防止检查中重复点击。

- [ ] Step 3: 优化监控卡片信息层级

使用设计 token 和语义状态色展示平台、动作、频率、最近检查、发现/入队统计、错误和检查中状态；所有按钮保留 focus-visible，不使用渐变。

- [ ] Step 4: 编译渲染模块并提交

Run: node --check src/renderer/app/monitor-page.js && node --check src/renderer/app.js && git diff --check

~~~bash
git add src/renderer/index.html src/renderer/app/monitor-page.js src/renderer/style.css src/renderer/app.js
git commit -m "feat: add monitor source and action controls"
~~~

### Task 5: 远程网页端监控页面

**Files:**
- Modify: src/main/services/remote-ui/index.html
- Modify: /Users/chenxincheng/AntBot/remote-ui/remote-ui/index.html

**Interfaces:**
- Consumes /remote/monitors routes and monitor-update SSE events。
- Produces the same monitor payload and action labels as the desktop page。

- [ ] Step 1: 增加远程监控 API 客户端

在单文件页面中加入 monitorApi，统一附带 token、解析错误和 monitor-update 处理；初始化加载列表，SSE 更新按 id 合并而不是追加。

- [ ] Step 2: 实现远程监控列表和配置弹窗

增加监控入口或主控区块，卡片展示平台、动作、频率、统计和错误；弹窗提供来源切换、主页链接、三种动作、发布覆盖和风格/音色选择。保存后刷新，不丢失未提交内容。

- [ ] Step 3: 实现检查、启停和删除

立即检查期间禁用按钮并显示“检查中”；启停失败回滚；删除二次确认；反馈统一使用现有 Toast、按钮和 modal 样式。

- [ ] Step 4: 同步本地热更新缓存并检查脚本

使用脚本提取两份 HTML 的 script 内容并通过 new Function 编译，随后用 cmp 确认内置页和本地缓存完全一致，再运行 git diff --check。

- [ ] Step 5: 提交远程页面改动

~~~bash
git add src/main/services/remote-ui/index.html
git commit -m "feat: add monitor controls to remote ui"
~~~

### Task 6: 集成验证、版本递增与 macOS 测试包

**Files:**
- Modify: package.json via npm version 0.8.9 --no-git-tag-version
- Modify: package-lock.json via the same command
- Modify: docs/packaging.md

- [ ] Step 1: 运行完整验证

~~~bash
node --test "src/main/services/tests/*.test.js" "publish-extension/local-server/tests/*.test.js"
node --check src/main/services/monitorService.js
node --check src/main/services/remoteServer.js
node --check src/main/taskRunner.js
node --check src/main/ipc/monitor.js
node --check src/main/ipc/remote.js
node --check src/renderer/app/monitor-page.js
git diff --check
~~~

Expected: 测试无失败，所有语法检查退出码为 0。

- [ ] Step 2: 按 9 进制规则递增版本并登记打包记录

当前版本 0.8.8，执行 npm version 0.8.9 --no-git-tag-version，并在 docs/packaging.md 顶部登记 YouTube/TikTok 监控、三种处理动作和两端同步。

- [ ] Step 3: 生成 macOS arm64 测试包

重新阅读 docs/packaging.md 后运行 npm run build:mac。产物必须位于 release/mac-arm64/搬运蚁.app，并按规范以可恢复改名方式同步到根目录搬运蚁.app，不能产生嵌套 .app。

- [ ] Step 4: 验证交付物并提交版本记录

~~~bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' './搬运蚁.app/Contents/Info.plist'
/usr/bin/codesign --verify --deep './搬运蚁.app'
find './搬运蚁.app' -maxdepth 2 -type d -name '搬运蚁.app'
git diff --check
git add package.json package-lock.json docs/packaging.md
git commit -m "chore: package monitor improvements as v0.8.9"
~~~

## Handoff

完成后交付桌面端和远程网页端的 YouTube/TikTok 监控、三种处理动作、旧数据兼容、根目录 v0.8.9 arm64 测试包，以及静态检查、单元测试和签名/版本核验结果。
