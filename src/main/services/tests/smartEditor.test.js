const assert = require('node:assert/strict');
const test = require('node:test');

const { createVisionFrameBatches, parseSrt } = require('../smartEditor');

test('splits recognition frames into API-safe groups without dropping frames', () => {
  assert.equal(typeof createVisionFrameBatches, 'function');

  const framePaths = Array.from({ length: 25 }, (_, index) => `frame-${index + 1}.jpg`);
  const batches = createVisionFrameBatches(framePaths);

  assert.deepEqual(batches.map((batch) => batch.length), [4, 4, 4, 4, 4, 4, 1]);
  assert.deepEqual(batches.flat(), framePaths);
});

test('parses consecutive SRT cues without blank-line separators', () => {
  assert.equal(typeof parseSrt, 'function');

  const entries = parseSrt(`1
00:00:01,000 --> 00:00:04,000
手绘起笔勾勒可爱轮廓
2
00:00:04,500 --> 00:00:07,500
蓝色马克笔填充头部
3
00:00:08,000 --> 00:00:11,000
细笔点睛添上粉腮红
4
00:00:11,500 --> 00:00:14,500
勾勒身体细节像小背包
5
00:00:15,000 --> 00:00:18,000
剪下纸片贴上煎蛋帽`);

  assert.deepEqual(entries.map((entry) => entry.text), [
    '手绘起笔勾勒可爱轮廓',
    '蓝色马克笔填充头部',
    '细笔点睛添上粉腮红',
    '勾勒身体细节像小背包',
    '剪下纸片贴上煎蛋帽',
  ]);
});

test('normalizes common AI timeline separator variants', () => {
  const entries = parseSrt(`1
00:00:01,000->00:00:04,000
手绘起笔勾勒可爱轮廓
2
00:00:04.500 -> 00:00:07.500
蓝色马克笔填充头部
3
00:00:08,0 → 00:00:11,00
细笔点睛添上粉腮红`);

  assert.deepEqual(entries, [
    { index: 1, startMs: 1000, endMs: 4000, text: '手绘起笔勾勒可爱轮廓' },
    { index: 2, startMs: 4500, endMs: 7500, text: '蓝色马克笔填充头部' },
    { index: 3, startMs: 8000, endMs: 11000, text: '细笔点睛添上粉腮红' },
  ]);
});

test('rejects an unreadable timeline instead of leaking it into subtitle text', () => {
  assert.throws(() => parseSrt(`1
00:00:01,000 --> 00:00:04,000
手绘起笔勾勒可爱轮廓
2
00:00:04.500 K 90.00.07.500
蓝色马克笔填充头部`), /字幕时间线格式异常/);
});
