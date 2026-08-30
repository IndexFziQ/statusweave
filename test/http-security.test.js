'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isLoopbackHost, isAllowedOrigin, publicFile } = require('../http-security');

test('local server rejects DNS-rebinding hostnames', () => {
  assert.equal(isLoopbackHost('127.0.0.1:8787'), true);
  assert.equal(isLoopbackHost('localhost:8787'), true);
  assert.equal(isLoopbackHost('[::1]:8787'), true);
  assert.equal(isLoopbackHost('attacker.example:8787'), false);
});

test('refresh origin must match a loopback server origin', () => {
  assert.equal(isAllowedOrigin(undefined, 8787), true);
  assert.equal(isAllowedOrigin('http://localhost:8787', 8787), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:8787', 8787), true);
  assert.equal(isAllowedOrigin('https://attacker.example', 8787), false);
  assert.equal(isAllowedOrigin('http://localhost:9999', 8787), false);
});

test('static paths cannot escape the public directory', () => {
  const root = path.resolve('/tmp/statusweave-public');
  assert.equal(publicFile(root, '/'), path.join(root, 'index.html'));
  assert.equal(publicFile(root, '/favicon.svg'), path.join(root, 'favicon.svg'));
  assert.equal(publicFile(root, '/../server.js'), null);
  assert.equal(publicFile(root, '/%2e%2e/server.js'), null);
  assert.equal(publicFile(root, '/%E0%A4%A'), null);
});
