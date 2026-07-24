/**
 * Test file to demonstrate the improved pacing algorithm.
 * Run with: node src/main/services/testSubtitleSplit.js
 */

// Import the functions (inline for testing since they're not exported)
function detectSentenceType(text, prevText) {
  const t = text.trim();
  const prev = (prevText || '').trim();

  if (/[！!？?。…~～]/.test(t) && t.length <= 6) return 'dramatic';
  if (/[？?]/.test(t)) return 'question';
  if (/[！!]/.test(t)) return 'exclamation';

  const topicShiftWords = /^(但是|然而|不过|然后|接下来|首先|其次|最后|总之|因此|所以|另外|此外|同时|而且|并且)/;
  if (topicShiftWords.test(t)) return 'topic_shift';

  if (/^[，,；;、]/.test(t) || (prev && /[，,；;、]$/.test(prev))) return 'continuation';
  if (t.length <= 4 && /^[啊哦嗯呢吧嘛呀哈嘿唉哇]/.test(t)) return 'interjection';

  return 'statement';
}

function calculateGap(prevEntry, currentEntry, nextEntry) {
  if (!prevEntry) return 0;

  const sentenceType = detectSentenceType(currentEntry.text, prevEntry.text);
  const prevType = detectSentenceType(prevEntry.text);

  const baseGaps = {
    continuation: 80,
    statement: 250,
    question: 350,
    exclamation: 400,
    dramatic: 600,
    topic_shift: 500,
    interjection: 150,
  };

  let gap = baseGaps[sentenceType] || 250;

  if (prevType === 'dramatic' || prevType === 'exclamation') {
    gap = Math.max(gap, 400);
  }

  const prevLength = prevEntry.text.length;
  if (prevLength > 15) gap += 100;
  if (prevLength > 25) gap += 150;

  // For testing, skip randomness
  // const jitter = gap * (0.85 + Math.random() * 0.3);
  // gap = Math.round(jitter);

  return Math.max(50, Math.min(gap, 1200));
}

function calculateNaturalDuration(entry, context = {}) {
  const text = entry.text.trim();
  const charCount = text.length;
  const sentenceType = detectSentenceType(text);

  const baseCharsPerSec = 3.8;

  let complexityMultiplier = 1.0;
  if (/[A-Za-z]{3,}/.test(text)) complexityMultiplier *= 1.15;
  if (/\d{2,}/.test(text)) complexityMultiplier *= 1.1;
  if (text.includes('...') || text.includes('…')) complexityMultiplier *= 1.2;

  const typeMultipliers = {
    continuation: 0.9,
    statement: 1.0,
    question: 1.15,
    exclamation: 1.2,
    dramatic: 1.4,
    topic_shift: 1.1,
    interjection: 0.7,
  };

  const typeMult = typeMultipliers[sentenceType] || 1.0;
  let durationMs = (charCount / baseCharsPerSec) * 1000 * complexityMultiplier * typeMult;

  const minDisplayTime = Math.max(1200, charCount * 180);
  durationMs = Math.max(durationMs, minDisplayTime);

  if (sentenceType === 'dramatic' && charCount <= 6) {
    durationMs = Math.max(durationMs, 1500);
  }

  const maxDuration = 6000;
  durationMs = Math.min(durationMs, maxDuration);

  return Math.round(durationMs);
}

// Test data: A typical video narration sequence
const testEntries = [
  { index: 1, startMs: 0, endMs: 3000, text: '大家好，欢迎来到今天的分享' },
  { index: 2, startMs: 3300, endMs: 6000, text: '首先我们来看一下背景' },
  { index: 3, startMs: 6300, endMs: 9000, text: '这是一个非常重要的技术突破' },
  { index: 4, startMs: 9300, endMs: 10000, text: '太棒了！' },
  { index: 5, startMs: 10300, endMs: 13000, text: '但是我们需要谨慎对待' },
  { index: 6, startMs: 13300, endMs: 15000, text: '接下来我们看看具体数据' },
  { index: 7, startMs: 15300, endMs: 17000, text: '2024年增长了35%' },
  { index: 8, startMs: 17300, endMs: 19000, text: '你觉得怎么样？' },
  { index: 9, startMs: 19300, endMs: 20000, text: '嗯' },
  { index: 10, startMs: 20300, endMs: 23000, text: '好的，我们继续看下一个案例' },
];

console.log('=== Subtitle Pacing Analysis ===\n');

console.log('Test Sequence:');
console.log('-'.repeat(80));

for (let i = 0; i < testEntries.length; i++) {
  const entry = testEntries[i];
  const prev = i > 0 ? testEntries[i - 1] : null;

  const type = detectSentenceType(entry.text, prev?.text);
  const duration = calculateNaturalDuration(entry, { prevText: prev?.text });
  const gap = calculateGap(prev, entry, null);

  console.log(`[${entry.index}] "${entry.text}"`);
  console.log(`    Type: ${type}`);
  console.log(`    Natural Duration: ${duration}ms (${(duration/1000).toFixed(1)}s)`);
  console.log(`    Gap from prev: ${gap}ms`);
  console.log(`    Original duration: ${entry.endMs - entry.startMs}ms`);
  console.log('');
}

console.log('\n=== Comparison with Old Algorithm ===\n');

console.log('Old Algorithm (fixed rules):');
console.log('- 300ms gap between ALL subtitles');
console.log('- Duration = max(1500, charCount * 250)');
console.log('');
console.log('Example for "太棒了！":');
console.log(`  Old: ${Math.max(1500, 4 * 250)}ms duration, 300ms gap`);
console.log(`  New: ${calculateNaturalDuration({text: '太棒了！'})}ms duration, 600ms gap (dramatic pause)`);
console.log('');

console.log('Example for "嗯":');
console.log(`  Old: ${Math.max(1500, 1 * 250)}ms duration, 300ms gap`);
console.log(`  New: ${calculateNaturalDuration({text: '嗯'})}ms duration, 150ms gap (interjection)`);
console.log('');

console.log('Example for "2024年增长了35%":');
console.log(`  Old: ${Math.max(1500, 8 * 250)}ms duration, 300ms gap`);
console.log(`  New: ${calculateNaturalDuration({text: '2024年增长了35%'})}ms duration, 250ms gap (numbers need processing)`);
console.log('');

console.log('\n=== Key Improvements ===\n');
console.log('1. Variable gaps based on sentence type (not fixed 300ms)');
console.log('2. Dramatic moments get longer pauses (600ms vs 300ms)');
console.log('3. Quick interjections are faster (150ms vs 300ms)');
console.log('4. Topic shifts get breathing room (500ms vs 300ms)');
console.log('5. Questions give audience time to think (350ms vs 300ms)');
console.log('6. Duration adapts to content complexity');
console.log('7. Numbers/English text gets extra processing time');
console.log('');
console.log('Result: Natural rhythm instead of robotic uniform timing.');
