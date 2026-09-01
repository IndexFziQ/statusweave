#!/usr/bin/env node
'use strict';

const { openDashboard } = require('./open-dashboard');

const agentCommands = new Set(['doctor', 'detect', 'launch', 'verify']);
const connectionCommands = new Set(['connect', 'disconnect']);
const args = process.argv.slice(2);
const command = process.argv[2];

function explicitlyRequestedProviders(input) {
  const equalsArg = input.find((arg) => arg.startsWith('--enable-ai='));
  const flagIndex = input.indexOf('--enable-ai');
  const raw = equalsArg
    ? equalsArg.slice('--enable-ai='.length)
    : flagIndex >= 0
      ? input[flagIndex + 1] || ''
      : '';
  return raw
    .toLowerCase()
    .split(',')
    .map((provider) => provider.trim())
    .filter((provider) => ['claude', 'codex', 'kimi'].includes(provider));
}

async function startDefault(shouldOpen = true) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  const url = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    const health = response.ok ? await response.json() : null;
    const isStatusWeave = health?.ok === true
      && Number.isInteger(health.pid)
      && Array.isArray(health.aiProviders)
      && typeof health.customEnabled === 'boolean';
    if (isStatusWeave) {
      const opened = shouldOpen && await openDashboard(url);
      console.log(`✓ StatusWeave is already running at ${url}`);
      console.log(opened ? '✓ Dashboard opened' : `Open ${url}`);
      const missingProviders = explicitlyRequestedProviders(args)
        .filter((provider) => !health.aiProviders.includes(provider));
      if (missingProviders.length) {
        console.warn(`! The running instance does not include ${missingProviders.join(', ')}. Stop it, then run this command again to apply --enable-ai.`);
      }
      return;
    }
  } catch {}

  if (shouldOpen) process.env.STATUSWEAVE_OPEN_DASHBOARD = '1';
  require('./server');
}

if (command === 'authorize') {
  require('./authorization').run(process.argv.slice(3)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
} else if (agentCommands.has(command)) {
  require('./agent').run(command, process.argv.slice(3)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
} else if (connectionCommands.has(command)) {
  require('./connect').run(command, process.argv.slice(3)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
} else if (command == null || (command.startsWith('-') && !['--help', '-h'].includes(command))) {
  startDefault(!args.includes('--no-open')).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  require('./server');
}
