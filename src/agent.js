'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { openDashboard } = require('./open-dashboard');

const IDS = ['claude', 'codex', 'kimi'];

function runLocal(runner, command, args) {
  try {
    return runner(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env },
    });
  } catch {
    return { status: null, stdout: '', stderr: '' };
  }
}

function installed(runner, command) {
  return runLocal(runner, 'which', [command]).status === 0;
}

function nextAction(code, command, description) {
  return { code, command, description };
}

function detectedProviders(home = os.homedir(), runner = spawnSync) {
  const exists = (...parts) => fs.existsSync(path.join(home, ...parts));
  const providers = [];

  const claudeInstalled = installed(runner, 'claude');
  let claudeAuth = 'unknown';
  let claudeMethod = null;
  if (!claudeInstalled) claudeAuth = 'unknown';
  else {
    const result = runLocal(runner, 'claude', ['auth', 'status', '--json']);
    try {
      const status = JSON.parse(result.stdout || '');
      claudeAuth = status.loggedIn === true ? 'ready' : status.loggedIn === false ? 'notLoggedIn' : 'unknown';
      claudeMethod = typeof status.authMethod === 'string' ? status.authMethod : null;
    } catch {
      claudeAuth = 'unknown';
    }
  }
  providers.push({
    id: 'claude',
    name: 'Claude Code',
    detected: claudeInstalled,
    installState: claudeInstalled ? 'installed' : 'missing',
    authState: claudeAuth,
    configState: claudeInstalled ? 'ready' : 'needsSetup',
    authMethod: claudeMethod,
    canLaunch: claudeAuth === 'ready',
    confidence: claudeInstalled ? 'official-cli' : 'executable-check',
    source: claudeInstalled ? 'claude auth status --json' : 'executable-check',
    nextAction: !claudeInstalled || claudeAuth === 'ready'
      ? null
      : claudeAuth === 'notLoggedIn'
        ? nextAction('login', 'claude auth login', 'Complete the official Claude Code sign-in flow yourself.')
        : nextAction('check-auth', 'claude auth status', 'StatusWeave could not verify authentication; inspect the official CLI status yourself.'),
  });

  const codexInstalled = installed(runner, 'codex');
  const codexStatus = codexInstalled ? runLocal(runner, 'codex', ['login', 'status']) : null;
  const codexCredential = exists('.codex', 'auth.json');
  const codexOutput = codexStatus ? `${codexStatus.stdout || ''}\n${codexStatus.stderr || ''}` : '';
  const codexAuth = !codexInstalled
    ? 'unknown'
    : codexStatus && codexStatus.status === 0
      ? 'ready'
      : codexCredential
        ? 'credentialPresent'
        : 'notLoggedIn';
  const codexMethod = /chatgpt/i.test(codexOutput)
    ? 'chatgpt'
    : /api key/i.test(codexOutput)
      ? 'api-key'
      : null;
  providers.push({
    id: 'codex',
    name: 'Codex',
    detected: codexInstalled,
    installState: codexInstalled ? 'installed' : 'missing',
    authState: codexAuth,
    configState: codexInstalled ? 'ready' : 'needsSetup',
    authMethod: codexMethod,
    canLaunch: codexAuth === 'ready',
    confidence: codexInstalled ? 'official-cli' : 'executable-check',
    source: codexInstalled ? 'codex login status' : 'executable-check',
    nextAction: !codexInstalled || codexAuth === 'ready'
      ? null
      : codexAuth === 'notLoggedIn'
        ? nextAction('login', 'codex login', 'Complete the official Codex sign-in flow yourself.')
        : nextAction('check-auth', 'codex login status', 'Credentials exist, but StatusWeave could not verify them; inspect the official CLI status yourself.'),
  });

  const kimiInstalled = installed(runner, 'kimi') || exists('.kimi-code', 'bin', 'kimi');
  const kimiHasCredential = exists('.kimi-code', 'credentials', 'kimi-code.json');
  const kimiAuth = !kimiInstalled
    ? 'unknown'
    : !kimiHasCredential
      ? 'notLoggedIn'
      : 'credentialPresent';
  providers.push({
    id: 'kimi',
    name: 'Kimi',
    detected: kimiInstalled,
    installState: kimiInstalled ? 'installed' : 'missing',
    authState: kimiAuth,
    configState: kimiInstalled ? 'ready' : 'needsSetup',
    authMethod: kimiHasCredential ? 'device-code' : null,
    canLaunch: kimiAuth === 'credentialPresent',
    confidence: kimiHasCredential ? 'credential-metadata' : 'executable-check',
    source: kimiHasCredential ? 'local credential metadata' : 'executable-check',
    nextAction: kimiInstalled && (kimiAuth === 'notLoggedIn' || kimiAuth === 'expired')
      ? nextAction('login', 'kimi login', 'Complete the official Kimi device-code sign-in flow yourself.')
      : null,
  });

  return providers;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function option(args, name) {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function requestedProviders(args, detected) {
  const raw = option(args, '--providers');
  const requested = raw
    ? raw.toLowerCase().split(',').map((value) => value.trim()).filter((value) => IDS.includes(value))
    : hasFlag(args, '--custom')
      ? []
    : detected.filter((provider) => provider.canLaunch).map((provider) => provider.id);
  return [...new Set(requested)].filter((id) => detected.some((provider) => provider.id === id && provider.canLaunch));
}

function portFromEnv(env = process.env) {
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return port;
}

async function getJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function health(port) {
  return getJson(`http://127.0.0.1:${port}/api/health`);
}

function doctorResult(home = os.homedir(), env = process.env) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const checks = {
    macOS: { ok: process.platform === 'darwin', value: process.platform },
    node: { ok: nodeMajor >= 18, value: process.version, required: '>=18' },
    git: { ok: git.status === 0, value: git.status === 0 ? git.stdout.trim() : 'not found' },
    source: { ok: fs.existsSync(path.join(__dirname, 'server.js')), value: __dirname },
  };
  return {
    schemaVersion: 1,
    command: 'doctor',
    // Git is useful for source installs but is not required by the npm package.
    ok: checks.macOS.ok && checks.node.ok && checks.source.ok,
    checks,
    providers: detectedProviders(home),
    port: portFromEnv(env),
  };
}

async function detectResult(home = os.homedir()) {
  return {
    schemaVersion: 1,
    command: 'detect',
    ok: true,
    readOnly: true,
    providers: detectedProviders(home),
  };
}

async function verifyResult(port, expected = [], expectCustom = false) {
  const h = await health(port);
  if (!h) {
    return { schemaVersion: 1, command: 'verify', ok: false, running: false, url: `http://localhost:${port}` };
  }
  const enabled = Array.isArray(h.aiProviders) ? h.aiProviders : [];
  const missing = expected.filter((id) => !enabled.includes(id));
  const usage = await getJson(`http://127.0.0.1:${port}/api/usage`);
  return {
    schemaVersion: 1,
    command: 'verify',
    ok: missing.length === 0 && (!expectCustom || h.customEnabled === true),
    running: true,
    pid: h.pid || null,
    url: `http://localhost:${port}`,
    enabledProviders: enabled,
    missingProviders: missing,
    customEnabled: h.customEnabled === true,
    providerStatus: usage && Array.isArray(usage.providers)
      ? usage.providers.filter((provider) => enabled.includes(provider.provider.toLowerCase())).map((provider) => ({
          id: provider.provider.toLowerCase(),
          detected: provider.detected,
          status: provider.error ? 'error' : provider.detected ? 'ready' : 'not-found',
        }))
      : [],
  };
}

async function launchResult(args, home = os.homedir(), env = process.env) {
  const doctor = doctorResult(home, env);
  if (!doctor.ok) return { schemaVersion: 1, command: 'launch', ok: false, reason: 'doctor-failed', doctor };

  const providers = requestedProviders(args, doctor.providers);
  const customRequested = hasFlag(args, '--custom');
  const rawRequested = option(args, '--providers');
  const missingDetected = rawRequested
    ? rawRequested.toLowerCase().split(',').map((value) => value.trim()).filter((id) => IDS.includes(id) && !providers.includes(id))
    : [];
  if (missingDetected.length) {
    return {
      schemaVersion: 1,
      command: 'launch',
      ok: false,
      reason: 'requested-provider-not-ready',
      missingProviders: missingDetected,
      providers: doctor.providers,
    };
  }
  if (!providers.length && !customRequested) {
    return {
      schemaVersion: 1,
      command: 'launch',
      ok: false,
      reason: 'no-supported-provider-detected',
      providers: doctor.providers,
    };
  }

  const port = doctor.port;
  const url = `http://localhost:${port}`;
  let h = await health(port);
  let started = false;
  const log = path.join(os.tmpdir(), `statusweave-${port}.log`);

  if (!h) {
    const logFd = fs.openSync(log, 'a', 0o600);
    fs.fchmodSync(logFd, 0o600);
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--enable-ai', providers.join(',')], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...env,
        PORT: String(port),
        ...(customRequested ? { STATUSWEAVE_ENABLE_CUSTOM: '1' } : {}),
      },
    });
    child.unref();
    fs.closeSync(logFd);
    started = true;
    for (let attempt = 0; attempt < 30 && !h; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      h = await health(port);
    }
  }

  if (!h) {
    return { schemaVersion: 1, command: 'launch', ok: false, reason: 'server-did-not-start', log };
  }

  const enabled = Array.isArray(h.aiProviders) ? h.aiProviders : [];
  const missing = providers.filter((id) => !enabled.includes(id));
  if (missing.length || (customRequested && h.customEnabled !== true)) {
    return {
      schemaVersion: 1,
      command: 'launch',
      ok: false,
      reason: 'existing-server-provider-mismatch',
      enabledProviders: enabled,
      missingProviders: missing,
      customEnabled: h.customEnabled === true,
      url,
    };
  }

  const opened = hasFlag(args, '--no-open') ? false : await openDashboard(url);
  const verified = await verifyResult(port, providers, customRequested);
  return { ...verified, command: 'launch', started, opened, log };
}

function printHuman(result) {
  if (result.command === 'detect') {
    for (const provider of result.providers) console.log(`${provider.canLaunch ? '✓' : '·'} ${provider.name}: ${provider.installState} / ${provider.authState}`);
    return;
  }
  if (result.command === 'doctor') {
    for (const [name, check] of Object.entries(result.checks)) console.log(`${check.ok ? '✓' : '✗'} ${name}: ${check.value}`);
    return;
  }
  if (result.ok) {
    console.log(`✓ StatusWeave is running at ${result.url}`);
    if (result.enabledProviders) console.log(`✓ AI providers: ${result.enabledProviders.join(', ')}`);
    if (result.opened) console.log('✓ Dashboard opened');
  } else {
    console.error(`✗ ${result.reason || 'verification failed'}`);
  }
}

async function run(command, args = []) {
  const json = hasFlag(args, '--json');
  const port = portFromEnv();
  const detected = detectedProviders();
  const expected = requestedProviders(args, detected);
  const expectCustom = hasFlag(args, '--custom');
  let result;
  if (command === 'doctor') result = doctorResult();
  else if (command === 'detect') result = await detectResult();
  else if (command === 'verify') result = await verifyResult(port, expected, expectCustom);
  else result = await launchResult(args);
  if (json) console.log(JSON.stringify(result));
  else printHuman(result);
  return result.ok ? 0 : 1;
}

module.exports = { run, detectedProviders, requestedProviders, doctorResult, verifyResult, launchResult };
