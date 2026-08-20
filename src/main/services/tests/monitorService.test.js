const test = require('node:test');
const assert = require('node:assert/strict');

const {
  migrateMonitor,
  inferSourceType,
  normalizeProcessMode,
  validateSourceUrl,
  sourceVideoKey,
  normalizeSourceVideo,
  processStages,
} = require('../monitorService');

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
  assert.equal(validateSourceUrl('https://www.youtube.com/@demo/videos', 'youtube'), 'https://www.youtube.com/@demo/videos');
});

test('标准化来源视频并生成平台化 key', () => {
  const video = normalizeSourceVideo({ id: 'abc', title: 'Demo', webpage_url: 'https://www.tiktok.com/@demo/video/abc' }, 'tiktok');
  assert.deepEqual(video, {
    id: 'abc',
    title: 'Demo',
    url: 'https://www.tiktok.com/@demo/video/abc',
    webpageUrl: 'https://www.tiktok.com/@demo/video/abc',
    uploadDate: '',
    timestamp: 0,
    duration: 0,
    sourceType: 'tiktok',
    key: 'tiktok:abc',
  });
});

test('三种处理动作映射到正确阶段', () => {
  assert.deepEqual(processStages('download'), ['download']);
  assert.deepEqual(processStages('edit'), ['download', 'edit']);
  assert.deepEqual(processStages('publish'), ['download', 'edit', 'publish']);
  assert.deepEqual(processStages('unknown'), ['download']);
});
