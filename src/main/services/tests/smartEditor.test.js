const assert = require('node:assert/strict');
const test = require('node:test');

const { createVisionFrameBatches } = require('../smartEditor');

test('splits recognition frames into API-safe groups without dropping frames', () => {
  assert.equal(typeof createVisionFrameBatches, 'function');

  const framePaths = Array.from({ length: 25 }, (_, index) => `frame-${index + 1}.jpg`);
  const batches = createVisionFrameBatches(framePaths);

  assert.deepEqual(batches.map((batch) => batch.length), [4, 4, 4, 4, 4, 4, 1]);
  assert.deepEqual(batches.flat(), framePaths);
});
