'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('macOS app build pins its deployment target and seals the bundle', () => {
  const script = read('float/build.sh');
  assert.match(script, /arm64-apple-macos12\.0/);
  assert.match(script, /codesign --force --sign - --timestamp=none/);
  assert.match(script, /codesign --verify --deep --strict/);
});

test('DMG asset name remains stable for the website latest-release link', () => {
  const asset = 'StatusWeave-macOS-arm64.dmg';
  assert.match(read('scripts/build-dmg.sh'), new RegExp(asset.replace('.', '\\.')));
  assert.match(read('README.md'), new RegExp(`releases/latest/download/${asset.replace('.', '\\.')}`));
  assert.match(read('README.zh-CN.md'), new RegExp(`releases/latest/download/${asset.replace('.', '\\.')}`));
  assert.match(read('docs/index.html'), new RegExp(`releases/latest/download/${asset.replace('.', '\\.')}`));
});

test('release workflow runs the platform-dependent test suite on macOS', () => {
  assert.match(read('.github/workflows/release.yml'), /runs-on: macos-latest/);
});

test('unsigned app instructions use the current macOS Open Anyway flow', () => {
  for (const file of ['README.md', 'README.zh-CN.md', 'docs/index.html', 'scripts/build-dmg.sh']) {
    const content = read(file);
    assert.doesNotMatch(content, /right-click|右键/i);
  }
  assert.match(read('README.md'), /Privacy & Security/);
  assert.match(read('README.zh-CN.md'), /隐私与安全性/);
});
