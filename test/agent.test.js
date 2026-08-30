'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectedProviders, requestedProviders } = require('../agent');

test('agent detection reports auth state without returning credentials', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'statusweave-agent-'));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), 'not parsed by StatusWeave');
  const runner = (command, args) => {
    if (command === 'which') return { status: ['claude', 'codex'].includes(args[0]) ? 0 : 1, stdout: '', stderr: '' };
    if (command === 'claude') return { status: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }), stderr: '' };
    if (command === 'codex') return { status: 0, stdout: '', stderr: 'Logged in' };
    return { status: 1, stdout: '', stderr: '' };
  };

  const providers = detectedProviders(home, runner);
  assert.deepEqual(providers.map((provider) => [provider.id, provider.installState, provider.authState]), [
    ['claude', 'installed', 'notLoggedIn'],
    ['codex', 'installed', 'ready'],
    ['kimi', 'missing', 'unknown'],
  ]);
  assert.equal(JSON.stringify(providers).includes('not parsed'), false);
  assert.deepEqual(requestedProviders([], providers), ['codex']);
  assert.deepEqual(requestedProviders(['--custom'], providers), []);
  assert.deepEqual(requestedProviders(['--providers', 'codex,kimi'], providers), ['codex']);
});
