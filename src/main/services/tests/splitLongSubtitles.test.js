const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { splitLongSubtitles, parseSrt } = require('../smartEditor');

describe('splitLongSubtitles', () => {
  it('should not split short subtitles', () => {
    const entries = [
      { index: 1, startMs: 0, endMs: 5000, text: '短句测试' },
      { index: 2, startMs: 5000, endMs: 10000, text: '另一个短句' },
    ];
    const result = splitLongSubtitles(entries);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].text, '短句测试');
    assert.strictEqual(result[1].text, '另一个短句');
  });

  it('should split long subtitles at punctuation', () => {
    const entries = [
      { index: 1, startMs: 0, endMs: 10000, text: '注意看！又是这位男人，视频开局直接高速对线' },
    ];
    const result = splitLongSubtitles(entries);
    assert.ok(result.length > 1);
    // 应该在！或，处拆分
    assert.ok(result[0].text.includes('！'));
    assert.ok(result[0].text.length <= 15);
  });

  it('should split long subtitles at natural boundaries', () => {
    const entries = [
      { index: 1, startMs: 0, endMs: 10000, text: '七星大佬想要拉开距离难度不小但八星大佬单手就能拿捏' },
    ];
    const result = splitLongSubtitles(entries);
    assert.ok(result.length > 1);
    // 每段应该不超过阈值
    result.forEach(entry => {
      assert.ok(entry.text.length <= 15);
    });
  });

  it('should maintain timing proportionality', () => {
    const entries = [
      { index: 1, startMs: 0, endMs: 10000, text: '一二三四五六七八九十，一二三四五六七八九十' },
    ];
    const result = splitLongSubtitles(entries);
    assert.strictEqual(result.length, 2);

    // 检查时间分配是否按比例
    const totalDuration = 10000;
    const totalChars = result.reduce((sum, e) => sum + e.text.length, 0);
    const expectedTimePerChar = totalDuration / totalChars;

    // 允许一定的误差
    const tolerance = 500;
    assert.ok(Math.abs((result[0].endMs - result[0].startMs) - result[0].text.length * expectedTimePerChar) <= tolerance);
  });

  it('should enforce minimum segment duration', () => {
    const entries = [
      { index: 1, startMs: 0, endMs: 5000, text: '很长的句子需要拆分，这是后半部分，还有更多内容需要继续' },
    ];
    const result = splitLongSubtitles(entries);
    assert.ok(result.length > 1);

    // 每段至少1.5秒
    result.forEach(entry => {
      const duration = entry.endMs - entry.startMs;
      assert.ok(duration >= 1500);
    });
  });

  it('should maintain dynamic gaps between segments', () => {
    const entries = [
      { index: 1, startMs: 0, endMs: 10000, text: '注意看！又是这位男人，视频开局直接高速对线' },
    ];
    const result = splitLongSubtitles(entries);
    assert.ok(result.length > 1);

    // Check dynamic gaps: continuation=80ms, exclamation=600ms
    // All gaps should be >= 0 (no overlapping)
    for (let i = 1; i < result.length; i++) {
      const gap = result[i].startMs - result[i - 1].endMs;
      assert.ok(gap >= 0);
    }
  });

  it('should re-index entries after splitting', () => {
    const entries = [
      { index: 1, startMs: 0, endMs: 5000, text: '短句' },
      { index: 2, startMs: 5000, endMs: 15000, text: '很长的句子需要拆分，这是后半部分，还有更多内容' },
      { index: 3, startMs: 15000, endMs: 20000, text: '另一个短句' },
    ];
    const result = splitLongSubtitles(entries);

    // 检查索引是否连续
    for (let i = 0; i < result.length; i++) {
      assert.strictEqual(result[i].index, i + 1);
    }
  });

  it('should handle empty entries', () => {
    const result = splitLongSubtitles([]);
    assert.strictEqual(result.length, 0);
  });

  it('should handle null entries', () => {
    const result = splitLongSubtitles(null);
    assert.strictEqual(result, null);
  });

  it('should handle real SRT format', () => {
    const srtText = `1
00:00:01,000 --> 00:00:06,000
注意看！又是这位男人，视频开局直接高速对线

2
00:00:06,000 --> 00:00:11,000
短句测试

3
00:00:11,000 --> 00:00:16,000
七星大佬想要拉开距离难度不小但八星大佬单手就能拿捏`;

    const entries = parseSrt(srtText);
    const result = splitLongSubtitles(entries);

    // 第一条应该被拆分
    assert.ok(result.length > 3);

    // 第二条不应该被拆分
    const secondEntry = result.find(e => e.text === '短句测试');
    assert.notStrictEqual(secondEntry, undefined);

    // 所有条目应该有正确的索引
    result.forEach((entry, idx) => {
      assert.strictEqual(entry.index, idx + 1);
    });
  });
});
