'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL_REPORT_URL = 'https://github.com/IndexFziQ/statusweave/issues/new?template=install_report.md';

function stateDir(env = process.env) {
  return env.STATUSWEAVE_STATE_DIR || path.join(os.homedir(), '.statusweave');
}

function firstRunInvite(env = process.env) {
  if (env.STATUSWEAVE_FEEDBACK_INVITE === '0') return null;
  const dir = stateDir(env);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    fs.chmodSync(dir, 0o700);
    const marker = path.join(dir, 'install-feedback-invited');
    const descriptor = fs.openSync(marker, 'wx', 0o600);
    fs.writeFileSync(descriptor, new Date().toISOString() + '\n');
    fs.closeSync(descriptor);
    fs.chmodSync(marker, 0o600);
    return [
      '📝 First run complete. Help improve installation (success or failure):',
      `   ${INSTALL_REPORT_URL}`,
      '   No telemetry is sent; opening a report is always your choice.',
    ];
  } catch (error) {
    if (error && error.code === 'EEXIST') return null;
    return null;
  }
}

module.exports = { INSTALL_REPORT_URL, firstRunInvite, _test: { stateDir } };
