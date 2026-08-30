'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tokens = require('../public/statusweave.tokens.json');

test('design tokens v3 define dark and light cross-surface themes', () => {
  assert.equal(tokens.version, 3);
  for (const name of [
    'background', 'panel', 'panelRaised', 'panelInset', 'ink', 'inkSecondary', 'muted', 'faint',
    'line', 'lineHard', 'healthy', 'active', 'warning', 'critical', 'offline', 'unknown', 'pink',
    'shadow',
  ]) {
    assert.match(tokens.colors[name], /^#[0-9a-f]{6}$/i, `${name} must be a hex color`);
    assert.match(tokens.themes.dark[name], /^#[0-9a-f]{6}$/i, `dark.${name} must be a hex color`);
    assert.match(tokens.themes.light[name], /^#[0-9a-f]{6}$/i, `light.${name} must be a hex color`);
  }
  assert.notEqual(tokens.themes.dark.background, tokens.themes.light.background);
  assert.equal(tokens.meter.segments, 10);
  assert.equal(tokens.meter.warningAt, 50);
  assert.equal(tokens.meter.criticalAt, 80);
});
