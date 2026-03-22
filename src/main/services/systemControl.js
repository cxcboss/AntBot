const fs = require('node:fs');
const path = require('node:path');
const { app, powerSaveBlocker } = require('electron');

function findAncestorAppBundles(executablePath) {
  const result = [];
  let current = path.resolve(path.dirname(String(executablePath || '')));

  while (current && current !== path.dirname(current)) {
    if (current.endsWith('.app')) {
      result.push(current);
    }
    current = path.dirname(current);
  }

  return result;
}

function resolveBundleExecutable(appBundlePath) {
  if (!appBundlePath) {
    return '';
  }
  const macOsDir = path.join(appBundlePath, 'Contents', 'MacOS');
  if (!fs.existsSync(macOsDir)) {
    return '';
  }

  const expected = path.join(macOsDir, path.basename(appBundlePath, '.app'));
  if (fs.existsSync(expected)) {
    return expected;
  }

  try {
    const entries = fs.readdirSync(macOsDir, { withFileTypes: true });
    const executable = entries.find((entry) => entry.isFile() && !entry.name.startsWith('.'));
    return executable ? path.join(macOsDir, executable.name) : '';
  } catch {
    return '';
  }
}

function resolvePreferredLoginItemPath() {
  const currentExecutable = app.getPath('exe');
  if (process.platform !== 'darwin') {
    return currentExecutable;
  }

  const bundles = findAncestorAppBundles(currentExecutable);
  if (bundles.length >= 2) {
    return resolveBundleExecutable(bundles[1]) || currentExecutable;
  }

  return currentExecutable;
}

function hasActiveExecution(progress = {}) {
  if (progress?.running) {
    return true;
  }
  const tasks = Array.isArray(progress?.tasks) ? progress.tasks : [];
  return tasks.some((item) => ['pending', 'running'].includes(String(item?.status || '')));
}

class SystemControlService {
  constructor() {
    this.settings = {
      preventSleepOnTasks: true,
      launchAtLogin: true
    };
    this.progress = {};
    this.sleepBlockerId = null;
  }

  applySettings(settings = {}) {
    this.settings = {
      preventSleepOnTasks: settings?.system?.preventSleepOnTasks !== false,
      launchAtLogin: settings?.system?.launchAtLogin !== false
    };

    this.syncLaunchAtLogin();
    this.syncSleepBlocker();
  }

  handleProgress(progress = {}) {
    this.progress = progress || {};
    this.syncSleepBlocker();
  }

  syncLaunchAtLogin() {
    if (!app.isPackaged) {
      return;
    }
    if (!['darwin', 'win32'].includes(process.platform)) {
      return;
    }

    try {
      const targetPath = resolvePreferredLoginItemPath();
      const options = {
        openAtLogin: this.settings.launchAtLogin !== false,
        openAsHidden: false
      };
      if (targetPath && targetPath !== app.getPath('exe')) {
        options.path = targetPath;
      }
      app.setLoginItemSettings(options);
    } catch (error) {
      console.warn('[system] sync launch-at-login failed:', error?.message || error);
    }
  }

  syncSleepBlocker() {
    const shouldPreventSleep = this.settings.preventSleepOnTasks !== false
      && hasActiveExecution(this.progress);

    if (shouldPreventSleep) {
      if (this.sleepBlockerId == null || !powerSaveBlocker.isStarted(this.sleepBlockerId)) {
        this.sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
      return;
    }

    if (this.sleepBlockerId != null && powerSaveBlocker.isStarted(this.sleepBlockerId)) {
      powerSaveBlocker.stop(this.sleepBlockerId);
    }
    this.sleepBlockerId = null;
  }

  dispose() {
    if (this.sleepBlockerId != null && powerSaveBlocker.isStarted(this.sleepBlockerId)) {
      powerSaveBlocker.stop(this.sleepBlockerId);
    }
    this.sleepBlockerId = null;
  }
}

module.exports = {
  SystemControlService,
  hasActiveExecution
};
