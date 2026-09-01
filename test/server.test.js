'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('help exits without starting collectors', () => {
  const result = spawnSync(process.execPath, ['src/server.js', '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /disabled by default|Explicitly enable/i);
});

test('remote AI access requires an additional acknowledgement', () => {
  const result = spawnSync(process.execPath, ['src/server.js', '--enable-ai', 'codex'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, STATUSWEAVE_HOST: '0.0.0.0' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to expose AI\/custom usage remotely/);
});
