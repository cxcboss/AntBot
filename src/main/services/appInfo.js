const path = require('node:path');
const { app } = require('electron');

function readPackageJson() {
  try {
    return require(path.resolve(__dirname, '..', '..', '..', 'package.json'));
  } catch {
    return {};
  }
}

function getAppInfo() {
  const pkg = readPackageJson();
  const configuredName = String(pkg.build?.productName || pkg.productName || pkg.name || '搬运蚁').trim() || '搬运蚁';
  const name = String(app?.isPackaged ? app?.getName?.() : configuredName).trim() || configuredName;
  const version = String(app?.getVersion?.() || pkg.version || '').trim();
  return {
    name,
    version,
    displayName: version ? `${name} v${version}` : name
  };
}

module.exports = {
  getAppInfo
};
