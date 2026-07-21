# store.js — 数据持久化

> 路径：`src/main/services/store.js`

## 职责

管理所有持久化数据：设置、历史记录、用户、发布记录、音色克隆状态。

## 数据结构

```js
{
  settings: { paths, style, voiceClone, commands, publish, api, edit, ... },
  history: [ { id, taskName, status, ... } ],
  users: [ { id, name, ... } ],
  activeUserId: 'user-1',
  publishedRecords: [ ... ]
}
```

## 核心方法

| 方法 | 说明 |
|------|------|
| `getSettings()` / `updateSettings(patch)` | 设置读写 |
| `getHistory()` / `appendHistory(record)` | 历史记录 |
| `createUser()` / `switchUser()` / `deleteUser()` | 多用户管理 |
| `setVoiceClone(result)` | 保存音色克隆结果 |
| `getLoginState()` / `setLoginState()` | 登录状态 |

## 存储位置

每个用户独立文件：`~/AntBot/users/{userId}/store.json`

## 注意事项

- 设置更新是增量 merge，不是全量覆盖
- 历史记录最多保留 200 条
- 用户删除时清理对应数据目录
