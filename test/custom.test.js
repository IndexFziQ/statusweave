'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function loadCustom(config) {
  process.env.STATUSWEAVE_PROVIDERS = config;
  delete require.cache[require.resolve('../src/custom')];
  return require('../src/custom');
}

test('custom command failures never return command text or secrets', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusweave-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const config = path.join(dir, 'providers.json');
  fs.writeFileSync(config, JSON.stringify([{
    name: 'broken',
    type: 'command',
    command: "printf 'super-secret' >&2; exit 1",
    metrics: [],
  }]));
  const custom = loadCustom(config);
  const [result] = await custom.collect();
  assert.equal(result.hint, 'fetch failed');
  assert.equal(JSON.stringify(result).includes('super-secret'), false);
});

test('custom HTTP providers read headers and nested JSON values', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer test-token');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ daily: { used: 4, max: 8, reset: 120 }, balance: 12.5 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusweave-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const config = path.join(dir, 'providers.json');
  const { port } = server.address();
  fs.writeFileSync(config, JSON.stringify([{
    name: 'Example API',
    type: 'http',
    url: `http://127.0.0.1:${port}/quota`,
    headers: { Authorization: 'Bearer test-token' },
    metrics: [
      { label: 'Daily', kind: 'percent', path: '$.daily.used', maxPath: '$.daily.max', resetPath: '$.daily.reset' },
      { label: 'Balance', kind: 'value', path: '$.balance', unit: ' USD' },
    ],
  }]));

  const custom = loadCustom(config);
  const [result] = await custom.collect();
  assert.equal(result.plan.windows[0].pct, 50);
  assert.equal(result.plan.windows[0].resetAfterSeconds, 120);
  assert.deepEqual(result.rows, [{ label: 'Balance', value: '12.5 USD' }]);
});
