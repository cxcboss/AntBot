# aiTaskParser.js — AI 意图解析（主控输入）

> 路径：`src/main/services/aiTaskParser.js`
> 依赖：`apiClient.js`（callApiWithKeyRotation）、`parser.js`（旧版规则复用）

## 职责

主控界面输入框的自由文本 → 结构化任务数组。支持「默认值声明 + 数据行 + 行内覆盖」的批量输入格式，单次输入可解析几十条重复任务。

## 输入格式（三段式）

```
① 默认值声明行（无链接，可多行，含：全部/默认/所有/活动/标题/每N分钟 等词）
   明天10:00开始 每3分钟一条 全部抖音原创 活动：双11 标题《双11捡漏第N期》 话题：#促销 #限时
② 数据行（每行至少一个链接，可带行内覆盖；一行多个链接 → 每个链接生成一个任务）
   https://v.douyin.com/aaa
   https://v.douyin.com/bbb 不原创
   https://v.douyin.com/ccc 13:30 发视频号 #自选话题
③ 行内覆盖：时间（HH:mm/月日/年月日）、平台（抖音/视频号）、原创（原创/不原创/不需要原创）、话题（#xxx）、活动、标题
```

## 分组语义（规则路径状态机）

- 无链接的声明行 → 更新当前默认，作用于**后续所有行**
- 数据行 URL **前缀**含分组指示词（都是/全部/所有/每个/下面的/剩下的）→ 提取为声明并更新当前默认，作用于后续行
- 数据行 URL 前缀含单条指示词（这条/这个）→ 声明只作用于本行（不更新默认）
- 支持跨行括号段落（`（...：URL1 URL2` / `（这条...：URL4）`）

**识别词表：**
- 平台：抖音 / 视频号 / 微信
- 原创：原创 → true；不原创/非原创/不需要原创/不用原创/不要原创 → false
- 时间：`10:30`、`X月X日`、`X点`（中文整点，已过则按「下午/次日」就近取未来）
- 间隔：`每N分钟` / `每隔N分钟` / `间隔N分钟` / `N-M分钟`（范围随机）
- 立刻：立刻发布/立即发布/马上发布 → 该条不参与间隔铺开，立即发布
- 标题模板：《…第N期…》/ {N}
- 活动：活动/参加活动/星图任务：xxx（不需要/无/不参加 → 视为无）

## 默认值五层优先级

```
行内覆盖 > 默认值声明行 > AI defaults > 系统内置默认
```

系统内置默认（`DEFAULT_*` 常量）：

| 字段 | 默认值 |
|------|--------|
| platforms | `['videoChannel']`（视频号） |
| isOriginal | `false`（不原创） |
| topics | `['#动画','#奇葩游戏','#游戏视频','#小游戏','#休闲游戏']`（与插件硬编码一致） |
| intervalMinutes | `[40, 70]` |

## 时间铺开（scheduleTasks）

- 批量（>1 条）且未声明时间：第 1 条立即（或声明行 startAt，已过则顺延次日），后续每条在前一条基础上随机 `intervalMinutes` 分钟
- 分组边界（`_batchStart`）重置铺开基准：新分组的第 1 条用该组声明的 startAt 或立即
- 「立刻发布」任务（`_explicitImmediate`）不参与间隔铺开，立即发布并重置基准
- 显式时间（行内/任务级）重置递推基准
- 时间在解析时固化写入 `publishAt`，持久化后不重摇

## URL 提取

- 一行多个 URL（连写 `…si=xxxhttps://…`）也能拆开（非贪婪 + lookahead 截断），每个 URL 生成一个任务
- URL 后接中文括号/引号/书名号等正常截断

## AI 触发策略（省 token）

`shouldUseAI()` 判定：所有行都是「裸链接 + 时间/平台/原创/话题 token」→ 纯规则路径（`parseByRules`），**不调 AI**。出现默认声明、活动、标题、文案、自然语言时间（明天/上午）、旧格式任务名等语义词 → 调 AI（一次调用整段输入，与条数无关）。

- AI 输出 JSON：`{ defaults, tasks[] }`，schema 见 `SYSTEM_PROMPT`
- AI 失败（无 key/超时/JSON 非法）→ 降级 `parseByRules`，`warnings` 提示，任务照常下发
- 标题模板：`titleTemplate` 用 `{N}` 或「第N期」占位，规则引擎按任务序号替换

## 返回契约（task:parse / task:start）

```js
{ tasks: [{ id, rawLine, taskName, publishAt, isOriginal, videoUrl, timeRange, platforms, publishCopy, publishTopics, campaignName, ai }],
  warnings: [], source: 'ai' | 'regex' | 'provided', defaults: { platforms, isOriginal, topics, intervalMinutes } }
```

## 双路径语义（v2）

- `task:parse` 接受 `opts.smart`：`true` 带 apiConfig 调 AI 智能解析（优化按钮）；`false`/缺省 → `apiConfig:null` 纯规则路径（直接发送），**不调 AI**，与旧版行为一致
- `task:start` 文本路径一律纯规则（`apiConfig:null`）；数组路径（已编辑预览/优化结果）原样提交

## 新字段 campaignName（活动名）

- 来源：声明行/行内「活动：xxx / 参加活动：xxx / 星图任务：xxx」，`不需要/无/不参加` 视为无
- 贯穿：解析 → taskRunner 快照/持久化（`main-control-tasks.json`）→ 任务卡片 tag 展示
- 发布时通过 `publisher.js` 的 `settings.campaignName` 参数通道传给浏览器插件；插件（weixin.js）发布视频号时优先用该活动名选择活动（`joinActivity`），无活动名时才回退到视频文件名的「小游戏-xxx」约定解析；文件名含「原创」时仍跳过活动选择

## 兼容性

- 旧逗号格式（`任务名，是否原创，链接`）走规则路径时复用 `parseTaskLine`，结果与旧版一致
- 旧时间格式（`2024-1-5 10:30` / `1月5日10:30` / `10:30`）全部保留
- 平台关键词、`#话题` 提取、原创判定逻辑不变
