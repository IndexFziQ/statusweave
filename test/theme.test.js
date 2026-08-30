'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

for (const file of ['public/index.html', 'docs/index.html']) {
  test(`${file} provides persistent dark and light themes`, () => {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(html, /data-theme/);
    assert.match(html, /prefers-color-scheme: light/);
    assert.match(html, /localStorage\.getItem\('sw-theme'\)/);
    assert.match(html, /#e9edf2/i);
    assert.match(html, /#0a0d14/i);
    assert.match(html, /aria-pressed/);
    assert.match(html, /background-color:\s*var\(--bg\)/);
  });
}

test('dashboard chart colors are theme-driven and redrawn on theme changes', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  assert.match(html, /--series-cpu/);
  assert.match(html, /cssVar\(s\.colorVar\)/);
  assert.match(html, /applyTheme[\s\S]*drawChart\(\)/);
});

test('shared dashboard tokens follow the active theme instead of forcing dark colors', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  assert.match(html, /sharedTokens\.themes\[activeTheme\]/);
  assert.match(html, /document\.documentElement\.dataset\.theme === 'light'/);
  assert.match(html, /applyTheme[\s\S]*applySharedTokens\(\)/);
  assert.match(html, /removeProperty\(cssVar\)/);
  assert.doesNotMatch(html, /Object\.entries\(tokens\.colors \|\| \{\}\)/);
});
