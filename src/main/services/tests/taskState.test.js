const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildRetryTask,
  dedupeTaskItems,
  getLogicalTaskId,
  mergeHistoryTaskItem,
  reconcileHistoryRecords,
} = require('../taskState');

test('retry task keeps one logical identity while receiving a new execution id', () => {
  const retry = buildRetryTask({
    id: 'task-old',
    taskName: '原视频',
    taskSnapshot: { id: 'task-old', taskName: '原视频' },
  }, 'task-new');

  assert.equal(retry.id, 'task-new');
  assert.equal(retry.logicalTaskId, 'task-old');
  assert.equal(retry.retryOf, 'task-old');
  assert.equal(getLogicalTaskId(retry), 'task-old');
});

test('dedupe keeps the newest attempt across different execution ids', () => {
  const items = dedupeTaskItems([
    { taskId: 'task-old', logicalTaskId: 'logical-1', status: 'warning', attempt: 1 },
    { taskId: 'task-new', logicalTaskId: 'logical-1', status: 'completed', attempt: 2 },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].taskId, 'task-new');
  assert.equal(items[0].status, 'completed');
});

test('history update matches taskId and retry aliases', () => {
  const item = { taskId: 'task-new', logicalTaskId: 'logical-1', retryOf: 'task-old', status: 'warning', message: '旧状态' };
  const updated = mergeHistoryTaskItem(item, 'task-old', {
    status: 'completed',
    message: '已发布到视频号',
    publishedPlatforms: ['videoChannel'],
  });

  assert.equal(updated.taskId, 'task-new');
  assert.equal(updated.status, 'completed');
  assert.equal(updated.message, '已发布到视频号');
  assert.deepEqual(updated.publishedPlatforms, ['videoChannel']);
});

test('history reconciliation keeps the latest attempt and removes older duplicate cards', () => {
  const records = [
    {
      id: 'run-new',
      startedAt: '2026-08-20T10:00:00.000Z',
      items: [{ taskId: 'task-new', logicalTaskId: 'logical-1', status: 'completed', attempt: 2 }],
    },
    {
      id: 'run-old',
      startedAt: '2026-08-20T09:00:00.000Z',
      items: [{ taskId: 'task-old', logicalTaskId: 'logical-1', status: 'warning', attempt: 1 }],
    },
  ];

  const result = reconcileHistoryRecords(records);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'run-new');
  assert.equal(result[0].items[0].status, 'completed');
});
