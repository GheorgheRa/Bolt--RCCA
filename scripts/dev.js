import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeArgs = ['--disable-warning=ExperimentalWarning', '--env-file-if-exists=.env'];
const viteArgs = process.argv.slice(2);
const children = [
  spawn(process.execPath, [...nodeArgs, 'server/index.js'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...viteArgs], { cwd: root, stdio: 'inherit' }),
];
let shuttingDown = false;

function stopChildren(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
}

for (const child of children) {
  child.on('error', error => {
    console.error(`Could not start a development process: ${error.message}`);
    stopChildren();
    process.exitCode = 1;
  });
  child.on('exit', code => {
    if (!shuttingDown && code !== 0) {
      process.exitCode = code || 1;
      stopChildren();
    }
  });
}

process.on('SIGINT', () => stopChildren('SIGINT'));
process.on('SIGTERM', () => stopChildren('SIGTERM'));
