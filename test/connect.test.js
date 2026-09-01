'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { endpoint, keychainAccount, keychainStore, KEYCHAIN_SERVICE } = require('../src/connect');
const custom = require('../src/custom');

test('authenticated endpoints are HTTPS and bound to their origin', () => {
  assert.equal(endpoint('https://api.example.com/usage#fragment').toString(), 'https://api.example.com/usage');
  assert.throws(() => endpoint('http://api.example.com/usage'), /HTTPS/);
  assert.throws(() => endpoint('https://user:secret@api.example.com/usage'), /credentials/);
  assert.equal(keychainAccount('my-api', 'https://api.example.com'), keychainAccount('my-api', 'https://api.example.com'));
  assert.notEqual(keychainAccount('my-api', 'https://api.example.com'), keychainAccount('my-api', 'https://other.example.com'));
});

test('Keychain writer delegates secret input directly to the macOS prompt', async () => {
  let called;
  const fakeSpawn = (command, args, options) => {
    called = { command, args, options };
    const child = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  };
  assert.equal(await keychainStore('my-api@origin', fakeSpawn), true);
  assert.equal(called.command, '/usr/bin/security');
  assert.equal(called.options.stdio, 'inherit');
  assert.equal(called.args.at(-1), '-w');
  assert.equal(called.args.some((arg) => /secret|token|key-value/i.test(arg)), false);
});

test('custom Bearer auth cannot reference arbitrary Keychain items or origins', () => {
  let account;
  const headers = custom._test.resolveHeaders({
    id: 'my-api',
    url: 'https://api.example.com/usage',
    auth: { type: 'bearer-keychain', origin: 'https://api.example.com' },
  }, (value) => { account = value; return 'secret'; });
  assert.equal(headers.Authorization, 'Bearer secret');
  assert.equal(account, keychainAccount('my-api', 'https://api.example.com'));
  assert.match(account, /^my-api@[a-f0-9]{16}$/);
  assert.equal(KEYCHAIN_SERVICE, 'dev.statusweave.api-key');
  assert.throws(() => custom._test.resolveHeaders({
    id: 'my-api',
    url: 'https://evil.example/usage',
    auth: { type: 'bearer-keychain', origin: 'https://api.example.com' },
  }, () => 'secret'), /origin mismatch/);
});
