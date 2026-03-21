const path = require('node:path');

const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/local/bin'
];

function buildRuntimePath(...pathValues) {
  const items = [];
  const seen = new Set();

  const pushEntries = (raw) => {
    String(raw || '')
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        if (seen.has(entry)) {
          return;
        }
        seen.add(entry);
        items.push(entry);
      });
  };

  for (const value of pathValues) {
    pushEntries(value);
  }
  pushEntries(process.env.PATH || '');
  pushEntries(process.env.ANTBOT_MANAGED_BIN || '');
  COMMON_BIN_DIRS.forEach((dir) => pushEntries(dir));

  const resourceBin = path.resolve(process.resourcesPath || '', 'bin');
  pushEntries(resourceBin);

  return items.join(path.delimiter);
}

function withRuntimeEnv(extraEnv = {}) {
  const merged = {
    ...process.env,
    ...extraEnv
  };
  merged.PATH = buildRuntimePath(extraEnv.PATH, process.env.PATH);
  return merged;
}

module.exports = {
  buildRuntimePath,
  withRuntimeEnv
};
