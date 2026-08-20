const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('renderer app bundles without syntax errors', () => {
  const root = path.resolve(__dirname, '../../../..');
  assert.doesNotThrow(() => {
    execFileSync('npx', [
      '--no-install',
      'esbuild',
      'src/renderer/app.js',
      '--bundle',
      '--format=esm',
      '--outfile=/tmp/antbot-renderer-syntax-check.js',
    ], { cwd: root, stdio: 'pipe' });
  });
});
