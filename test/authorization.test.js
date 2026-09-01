'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const authorization = require('../src/authorization');
const { enabledProviders } = require('../src/usage');

function isolatedEnv() {
  return { ...process.env, STATUSWEAVE_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'statusweave-auth-test-')) };
}

test('authorization stores consent metadata with private permissions', () => {
  const env = isolatedEnv();
  authorization._test.saveProvider('claude', {
    consented: true,
    consentVersion: 1,
    state: 'CONSENTED',
    lastVerifiedAt: '2026-08-29T00:00:00.000Z',
  }, env);

  const state = authorization.readState(env);
  assert.equal(state.providers.claude.consented, true);
  assert.deepEqual([...authorization.consentedProviders(env)], ['claude']);
  assert.equal(fs.statSync(env.STATUSWEAVE_STATE_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(env.STATUSWEAVE_STATE_DIR, 'authorization.json')).mode & 0o777, 0o600);
});

test('authorized providers are enabled without a per-launch flag', () => {
  const env = isolatedEnv();
  authorization._test.saveProvider('kimi', { consented: true, state: 'CONSENTED' }, env);
  assert.deepEqual([...enabledProviders([], env)], ['kimi']);
});

test('incomplete interactive setup does not enable a provider', () => {
  const env = isolatedEnv();
  authorization._test.saveProvider('claude', { consented: true, state: 'INTERACTION_REQUIRED' }, env);
  assert.deepEqual([...enabledProviders([], env)], []);
});

test('provider lists are explicit and reject unknown names', () => {
  assert.deepEqual(authorization.parseProviderList(['claude,codex', 'claude']), ['claude', 'codex']);
  assert.throws(() => authorization.parseProviderList(['unknown']), /Unsupported provider/);
});

test('probe directories reject symbolic links', () => {
  const env = isolatedEnv();
  const probes = path.join(env.STATUSWEAVE_STATE_DIR, 'cli-probes');
  fs.mkdirSync(probes, { mode: 0o700 });
  fs.symlinkSync(os.tmpdir(), path.join(probes, 'claude'));
  assert.throws(() => authorization.probeDir('claude', env), /Unsafe StatusWeave directory/);
});
