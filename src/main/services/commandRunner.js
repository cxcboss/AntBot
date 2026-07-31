const { spawn } = require('node:child_process');
const { withRuntimeEnv } = require('./runtimeEnv');

function escapeArg(arg) {
  const raw = String(arg ?? '');
  if (!raw.length) {
    return '""';
  }
  if (!/[^\w@%+=:,./-]/.test(raw)) {
    return raw;
  }
  return `"${raw.replace(/(["\\$`])/g, '\\$1')}"`;
}

function formatCommand(command, args = []) {
  const parts = [command, ...(Array.isArray(args) ? args : [])].map((part) => escapeArg(part));
  return parts.join(' ');
}

function runCommandArgs(command, args = [], options = {}) {
  const {
    cwd,
    env = {},
    shell = false,
    log = () => {},
    timeoutMs = 0
  } = options;

  const safeArgs = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  const commandText = formatCommand(command, safeArgs);

  return new Promise((resolve, reject) => {
    const child = spawn(command, safeArgs, {
      cwd,
      env: withRuntimeEnv(env),
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`命令执行超时（${timeoutMs}ms）：${commandText}`));
      }, timeoutMs);
    }

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (text.trim()) {
        log(text.trim());
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (text.trim()) {
        log(text.trim());
      }
    });

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`命令启动失败：${commandText}\n${error.message}`));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`命令执行失败（exit=${code}）：${commandText}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr, code, command: commandText });
    });
  });
}

module.exports = {
  runCommandArgs
};
