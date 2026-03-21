const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.join(rootDir, 'release');
const metadataPath = path.join(releaseDir, 'latest-mac.yml');
const pkg = require(path.join(rootDir, 'package.json'));

if (!fs.existsSync(metadataPath)) {
  process.exit(0);
}

const version = String(pkg.version || '').trim();
if (!version) {
  throw new Error('package.json 缺少 version。');
}

const dmgFile = fs.readdirSync(releaseDir).find((fileName) => {
  return new RegExp(`^搬运蚁-${version}-mac-[^.]+\\.dmg$`).test(fileName);
});

if (!dmgFile) {
  throw new Error(`未在 release 目录找到版本 ${version} 的 Mac DMG。`);
}

const original = fs.readFileSync(metadataPath, 'utf8');
const updated = original
  .replace(/^  - url: .+$/m, `  - url: ${dmgFile}`)
  .replace(/^path: .+$/m, `path: ${dmgFile}`);

if (updated !== original) {
  fs.writeFileSync(metadataPath, updated, 'utf8');
  console.log(`[fix-mac-update-metadata] updated latest-mac.yml -> ${dmgFile}`);
} else {
  console.log('[fix-mac-update-metadata] latest-mac.yml already matched build artifact.');
}
