const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridgeQueue } = require('../bridgeQueue');

test('bridge queue accepts, claims, resolves, and snapshots a command', () => {
  const queue = createBridgeQueue();
  const accepted = queue.enqueue({ id: 'req-1', action: 'publish.start', payload: { platform: 'douyin' } });

  assert.equal(accepted.status, 'queued');
  assert.deepEqual(queue.claim(), {
    id: 'req-1',
    action: 'publish.start',
    payload: { platform: 'douyin' },
    createdAt: accepted.createdAt,
    status: 'running',
    startedAt: queue.get('req-1').startedAt
  });

  const completed = queue.resolve('req-1', { success: true, status: 'completed', records: [] });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(queue.get('req-1').result, { success: true, status: 'completed', records: [] });
  assert.equal(queue.snapshot().pending.length, 0);
  assert.equal(queue.snapshot().history[0].id, 'req-1');
});

test('bridge queue rejects duplicate IDs and supports cancellation', () => {
  const queue = createBridgeQueue();
  queue.enqueue({ id: 'req-2', action: 'publish.stop' });
  assert.throws(() => queue.enqueue({ id: 'req-2', action: 'publish.stop' }), /已存在/);
  queue.claim();
  const cancelled = queue.cancel('req-2');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.result.error, '已取消');
});
