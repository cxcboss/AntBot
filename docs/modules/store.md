# store.js — 数据持久化

> 路径：`src/main/services/store.js`（~700 行）

## 职责

管理所有持久化数据：设置、历史记录、用户、发布记录、音色克隆状态、登录状态。

## 数据结构

```js
{
  settings: { paths, style, voiceClone, publish, api, edit, ... },
  history: [ { id, taskName, status, ... } ],
  users: [ { id, name, ... } ],
  activeUserId: 'user-1',
  publishedRecords: [ ... ],
  sharedLoginState: { videoChannel: { loggedIn, checkedAt }, douyin: { loggedIn, checkedAt } }
}
```

## 核心方法

| 方法 | 说明 |
|------|------|
| `getSettings()` / `updateSettings(patch)` | 设置读写（增量 merge） |
| `getHistory()` / `appendHistory(record)` | 历史记录（最多 200 条） |
| `getLoginState()` / `setLoginState(service, loggedIn)` | 平台登录状态 |
| `setVoiceClone(result)` | 保存音色克隆结果 |
| `appendPublishedRecords(records)` | 追加发布记录 |

## 存储位置

**单一文件**：`~/AntBot/antbot-store.json`（`STORE_FILE` 常量，`dataDir || app.getPath('userData')`）。

多用户数据（`users` 数组 + `activeUserId`）存于同一文件内，不再按用户拆目录。

## 向后兼容

旧版本数据中的 `geminiProfileId`、`geminiProfiles`、`loginState.gemini` 字段在加载时自动删除，不会报错。

## 注意事项

- 设置更新是增量 merge，不是全量覆盖
- 历史记录最多保留 200 条
- `cloneSettingsForUser()` 会清理敏感字段（API key 等）
