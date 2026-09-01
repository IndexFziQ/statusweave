'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { openDashboard } = require('../src/open-dashboard');

const launcher = path.join(__dirname, '..', 'src', 'statusweave.js');

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return response.json();
    } catch {}
  }
  return null;
}

function runLauncher(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('dashboard opener uses the native command for each platform', async () => {
  const calls = [];
  const runner = (command, args, callback) => {
    calls.push([command, args]);
    callback(null);
  };

  assert.equal(await openDashboard('http://127.0.0.1:8787', 'darwin', runner), true);
  assert.equal(await openDashboard('http://127.0.0.1:8787', 'linux', runner), true);
  assert.equal(await openDashboard('http://127.0.0.1:8787', 'win32', runner), true);
  assert.deepEqual(calls, [
    ['open', ['http://127.0.0.1:8787']],
    ['xdg-open', ['http://127.0.0.1:8787']],
    ['cmd.exe', ['/c', 'start', '', 'http://127.0.0.1:8787']],
  ]);
});

test('--no-open starts a system-only dashboard', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusweave-launcher-'));
  const port = await getFreePort();
  const env = { PORT: String(port), STATUSWEAVE_STATE_DIR: stateDir, STATUSWEAVE_FEEDBACK_INVITE: '0' };
  const child = spawn(process.execPath, [launcher, '--no-open'], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const health = await waitForHealth(port);

  assert.equal(health?.ok, true);
  assert.deepEqual(health?.aiProviders, []);

  const reused = await runLauncher(['--no-open'], env);
  assert.equal(reused.code, 0);
  assert.match(reused.stdout, /already running/);
  assert.equal(reused.stderr, '');

  const mismatched = await runLauncher(['--enable-ai', 'claude', '--no-open'], env);
  assert.equal(mismatched.code, 0);
  assert.match(mismatched.stdout, /already running/);
  assert.match(mismatched.stderr, /does not include claude/);
});

test('a foreign HTTP service is not mistaken for StatusWeave', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusweave-launcher-'));
  const port = await getFreePort();
  const foreign = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    foreign.once('error', reject);
    foreign.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => {
    foreign.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const result = await runLauncher(['--no-open'], {
    PORT: String(port),
    STATUSWEAVE_STATE_DIR: stateDir,
    STATUSWEAVE_FEEDBACK_INVITE: '0',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`Port ${port} is already in use`));
  assert.doesNotMatch(result.stderr, /Unhandled|already running/);
});

test('invalid ports fail cleanly for both default and fallback commands', async () => {
  for (const args of [['--no-open'], ['unknown-command']]) {
    const result = await runLauncher(args, { PORT: 'not-a-port' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /PORT must be an integer from 1 to 65535/);
    assert.doesNotMatch(result.stderr, /TypeError|RangeError|at Server/);
  }
});
