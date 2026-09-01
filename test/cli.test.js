'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'src', 'cli.js');

test('CLI help documents native, plain, ASCII, and JSON renderers', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--ascii/);
  assert.match(result.stdout, /--color=auto\|always\|never/);
  assert.match(result.stdout, /--once/);
  assert.match(result.stdout, /--json/);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
});

test('CLI rejects unsupported color modes before starting the service', () => {
  const result = spawnSync(process.execPath, [cli, '--color=rainbow'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /auto, always, or never/);
});
