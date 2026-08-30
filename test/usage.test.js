'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { collectUsage, enabledProviders, _test } = require('../usage');

test('AI providers are disabled by default', async () => {
  assert.deepEqual([...enabledProviders([], {})], []);
  const usage = await collectUsage({ enabled: new Set(), enableCustom: false });
  assert.deepEqual(usage.providers.map((p) => [p.provider, p.enabled]), [
    ['Claude', false],
    ['Codex', false],
    ['Kimi', false],
  ]);
});

test('providers require an explicit allowlist', () => {
  assert.deepEqual(
    [...enabledProviders(['--enable-ai', 'claude,kimi,unknown'], {})],
    ['claude', 'kimi']
  );
  assert.deepEqual(
    [...enabledProviders([], { STATUSWEAVE_AI_PROVIDERS: 'codex' })],
    ['codex']
  );
});

test('Claude plan parser keeps only known limit windows', () => {
  assert.deepEqual(_test.parseClaudePlan({
    five_hour: { utilization: 42, resets_at: '2026-08-28T12:00:00Z' },
    seven_day: { utilization: 7 },
  }, 'pro'), {
    tier: 'pro',
    windows: [
      { key: '5h', label: '5h limit', pct: 42, resetsAt: '2026-08-28T12:00:00Z' },
      { key: 'weekly', label: 'Weekly limit', pct: 7, resetsAt: null },
    ],
  });
});

test('Claude plan parser supports the structured limits response', () => {
  assert.deepEqual(_test.parseClaudePlan({ limits: [
    { kind: 'session', percent: 4, resets_at: '2026-08-30T07:20:00Z' },
    { kind: 'weekly_all', percent: 12, resets_at: '2026-09-05T06:00:00Z' },
    { kind: 'weekly_scoped', percent: 2, resets_at: null, scope: { model: { display_name: 'Fable' } } },
  ] }, 'max'), {
    tier: 'max',
    windows: [
      { key: '5h', label: 'Session limit', pct: 4, resetsAt: '2026-08-30T07:20:00Z' },
      { key: 'weekly', label: 'Weekly limit', pct: 12, resetsAt: '2026-09-05T06:00:00Z' },
      { key: 'weekly-fable', label: 'Weekly Fable limit', pct: 2, resetsAt: null },
    ],
  });
});

test('Codex plan parser normalizes rate-limit windows', () => {
  const plan = _test.parseCodexPlan({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 600 },
      secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: 1787900000 },
    },
  });
  assert.equal(plan.tier, 'plus');
  assert.deepEqual(plan.windows.map((w) => [w.key, w.pct]), [['5h', 25], ['weekly', 50]]);
});

test('Kimi status parser ignores unrelated terminal output', () => {
  const plan = _test.parseKimiStatus('5h limit 12% used resets in 2h 3m  | Weekly limit 34% used resets in 4d 5h  |');
  assert.deepEqual(plan.windows.map((w) => [w.key, w.pct, w.resetAfterSeconds]), [
    ['5h', 12, 7380],
    ['weekly', 34, 363600],
  ]);
  assert.equal(_test.parseKimiStatus('login required'), null);
});

test('Kimi executable paths are shell-quoted', () => {
  const value = "/tmp/a b'$(printf injected)";
  const result = spawnSync('/bin/sh', ['-c', `printf %s ${_test.shellQuote(value)}`], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, value);
});

test('plan cache keeps the last successful limits when a refresh returns empty windows', () => {
  const cache = new Map();
  const start = Date.parse('2026-08-30T08:00:00Z');
  _test.withPlanCache({
    provider: 'Claude',
    detected: true,
    plan: {
      tier: 'max',
      windows: [{ key: '5h', label: '5h limit', pct: 31, resetAfterSeconds: 3600 }],
    },
  }, start, cache);

  const provider = _test.withPlanCache({
    provider: 'Claude',
    detected: true,
    plan: { tier: 'max', windows: [] },
  }, start + 60000, cache);

  assert.equal(provider.plan.windows[0].pct, 31);
  assert.equal(provider.plan.windows[0].resetAfterSeconds, 3540);
  assert.equal(provider.planStale, true);
  assert.equal(provider.planCachedAt, start);
});

test('plan cache is not reused after an authentication failure', () => {
  const cache = new Map([['Claude', {
    cachedAt: 1000,
    plan: { tier: 'max', windows: [{ key: 'weekly', label: 'Weekly limit', pct: 20 }] },
  }]]);
  const provider = _test.withPlanCache({
    provider: 'Claude', detected: true, plan: null, error: 'login required',
  }, 2000, cache);
  assert.equal(provider.plan, null);
  assert.equal(provider.planStale, undefined);
});
