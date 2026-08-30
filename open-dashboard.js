'use strict';

const { execFile } = require('child_process');

function openDashboard(url, platform = process.platform, runner = execFile) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    try {
      runner(command, args, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

module.exports = { openDashboard };
