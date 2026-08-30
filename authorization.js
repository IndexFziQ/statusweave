#!/usr/bin/env node
'use strict';

/**
 * One-time local CLI monitoring setup.
 *
 * StatusWeave stores consent metadata only. Login, MFA, account choice, and
 * folder trust happen in the provider's visible interactive process. Enabled
 * collectors may use that CLI's existing session in memory to request the
 * corresponding provider's official usage endpoint, but never persist it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const readline = require('readline/promises');

const PROVIDERS = ['claude', 'codex', 'kimi'];
const CONSENT_VERSION = 1;

function stateDir(env = process.env) {
  return env.STATUSWEAVE_STATE_DIR || path.join(os.homedir(), '.statusweave');
}

function stateFile(env = process.env) {
  return path.join(stateDir(env), 'authorization.json');
}

function assertSafeDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe StatusWeave directory: ${dir}`);
  fs.chmodSync(dir, 0o700);
  return dir;
}

function probeDir(provider, env = process.env) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unsupported provider: ${provider}`);
  const root = assertSafeDirectory(path.join(stateDir(env), 'cli-probes'));
  const dir = path.join(root, provider);
  assertSafeDirectory(dir);
  return dir;
}

function emptyState() {
  return { schemaVersion: 1, providers: {} };
}

function readState(env = process.env) {
  try {
    const file = stateFile(env);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.schemaVersion === 1 && parsed.providers ? parsed : emptyState();
  } catch {
    return emptyState();
  }
}

function writeState(state, env = process.env) {
  const dir = assertSafeDirectory(stateDir(env));
  const file = stateFile(env);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Unsafe authorization file: ${file}`);
  const temporary = path.join(dir, `.authorization-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function record(provider, env = process.env) {
  return readState(env).providers[provider] || null;
}

function consentedProviders(env = process.env) {
  const providers = readState(env).providers;
  return new Set(PROVIDERS.filter((provider) =>
    providers[provider]?.consented === true && providers[provider]?.state === 'CONSENTED'
  ));
}

function saveProvider(provider, patch, env = process.env) {
  const state = readState(env);
  state.providers[provider] = { ...(state.providers[provider] || {}), ...patch };
  writeState(state, env);
  return state.providers[provider];
}

function findExecutable(provider, env = process.env) {
  const override = env[`STATUSWEAVE_${provider.toUpperCase()}_BIN`];
  if (override) {
    try { return fs.realpathSync(override); } catch { return null; }
  }
  const command = provider;
  try {
    const found = execFileSync('/usr/bin/which', [command], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], env,
    }).trim();
    return found ? fs.realpathSync(found) : null;
  } catch {
    const kimi = provider === 'kimi' ? path.join(os.homedir(), '.kimi-code', 'bin', 'kimi') : null;
    return kimi && fs.existsSync(kimi) ? fs.realpathSync(kimi) : null;
  }
}

function cliVersion(provider, executable) {
  if (!executable) return null;
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? String(result.stdout || result.stderr || '').trim().slice(0, 160) : null;
}

function authCheck(provider, executable) {
  if (!executable) return { ok: false, state: 'CLI_MISSING', detail: 'Official CLI not found' };
  if (provider === 'claude') {
    const result = spawnSync(executable, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const parsed = JSON.parse(result.stdout || '{}');
      return parsed.loggedIn
        ? { ok: true, state: 'CONSENTED', detail: parsed.subscriptionType || parsed.authMethod || 'logged in' }
        : { ok: false, state: 'AUTH_REQUIRED', detail: 'Claude Code login required' };
    } catch {
      return { ok: false, state: 'AUTH_REQUIRED', detail: 'Claude Code login could not be verified' };
    }
  }
  if (provider === 'codex') {
    const result = spawnSync(executable, ['login', 'status'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0
      ? { ok: true, state: 'CONSENTED', detail: 'logged in' }
      : { ok: false, state: 'AUTH_REQUIRED', detail: 'Codex login required' };
  }
  const credentialRoots = [path.join(os.homedir(), '.kimi-code'), path.join(os.homedir(), '.config', 'kimi')];
  return credentialRoots.some((dir) => fs.existsSync(dir))
    ? { ok: true, state: 'CONSENTED', detail: 'local login metadata present' }
    : { ok: false, state: 'AUTH_REQUIRED', detail: 'Kimi Code login required' };
}

function providerSnapshot(provider, env = process.env) {
  const saved = record(provider, env);
  const executable = findExecutable(provider, env);
  const auth = authCheck(provider, executable);
  let state = saved?.state || 'NOT_CONFIGURED';
  if (!executable) state = 'CLI_MISSING';
  else if (saved?.consented && !auth.ok) state = 'AUTH_REQUIRED';
  else if (!saved?.consented) state = saved?.state === 'CONSENT_REVOKED' ? 'CONSENT_REVOKED' : 'NOT_CONFIGURED';
  return {
    provider,
    state,
    consented: saved?.consented === true,
    cliInstalled: Boolean(executable),
    cliVersion: saved?.cliVersion || cliVersion(provider, executable),
    lastVerifiedAt: saved?.lastVerifiedAt || null,
    detail: auth.detail,
  };
}

function parseProviderList(args) {
  const values = args.flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(values)];
  const invalid = unique.filter((value) => !PROVIDERS.includes(value));
  if (invalid.length) throw new Error(`Unsupported provider: ${invalid.join(', ')}`);
  return unique;
}

function printStatus(json, env = process.env) {
  const snapshot = PROVIDERS.map((provider) => providerSnapshot(provider, env));
  if (json) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, providers: snapshot }, null, 2) + '\n');
    return;
  }
  process.stdout.write('StatusWeave CLI monitoring authorization\n\n');
  for (const item of snapshot) {
    process.stdout.write(`  ${item.provider.padEnd(7)} ${item.state.padEnd(20)} ${item.detail}\n`);
  }
  process.stdout.write('\nSet up: statusweave authorize claude,codex,kimi\n');
  process.stdout.write('Revoke: statusweave authorize --reset <provider>\n');
}

async function confirmUsage(provider) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Did ${provider} show its usage/status screen successfully? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function authorizeProvider(provider, env = process.env) {
  const executable = findExecutable(provider, env);
  if (!executable) {
    saveProvider(provider, { consented: true, consentVersion: CONSENT_VERSION, state: 'CLI_MISSING', updatedAt: new Date().toISOString() }, env);
    process.stdout.write(`\n[${provider}] Official CLI not found. Install it, then run this command again.\n`);
    return false;
  }

  const dir = probeDir(provider, env);
  const version = cliVersion(provider, executable);
  saveProvider(provider, {
    consented: true,
    consentVersion: CONSENT_VERSION,
    consentedAt: new Date().toISOString(),
    state: 'INTERACTION_REQUIRED',
    cliVersion: version,
  }, env);

  process.stdout.write(`\n[${provider}] One-time interactive setup\n`);
  process.stdout.write(`  Official CLI: ${executable}\n`);
  process.stdout.write(`  Empty probe directory: ${dir}\n`);
  process.stdout.write('  If this CLI is already logged in, StatusWeave will not ask you to log in again.\n');
  process.stdout.write('  If login/MFA is required, complete it yourself in the visible official CLI.\n');
  process.stdout.write('  Trust only the empty probe directory shown above.\n');
  process.stdout.write(`  Then open ${provider === 'kimi' ? '/status' : '/usage'} and exit the CLI.\n`);
  process.stdout.write('  StatusWeave will not ask for or store your credentials. Enabled collectors may use the CLI session in memory only for that provider usage check.\n\n');

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write('Interactive terminal required. Re-run this command in Terminal.\n');
    return false;
  }

  let auth = authCheck(provider, executable);
  if (!auth.ok) {
    const loginArgs = provider === 'claude' ? ['auth', 'login'] : ['login'];
    process.stdout.write(`[${provider}] No valid CLI login was detected. Opening the official login flow now.\n`);
    const login = spawnSync(executable, loginArgs, { cwd: dir, stdio: 'inherit', env });
    auth = authCheck(provider, executable);
    if (login.error || !auth.ok) {
      saveProvider(provider, { state: auth.state, lastError: auth.detail, updatedAt: new Date().toISOString() }, env);
      process.stdout.write(`[${provider}] ${auth.detail}. Authorization is not complete.\n`);
      return false;
    }
  } else {
    process.stdout.write(`[${provider}] Existing CLI login detected; skipping login.\n`);
  }

  // Codex exposes a structured login/usage path, so a successful login check is
  // sufficient. Claude and Kimi still need the user to verify their slash-command UI.
  let child = null;
  if (provider !== 'codex') {
    process.stdout.write(`[${provider}] Opening the CLI. Run ${provider === 'kimi' ? '/status' : '/usage'}, then exit.\n`);
    child = spawnSync(executable, [], { cwd: dir, stdio: 'inherit', env });
  }
  if (child?.error) {
    saveProvider(provider, { state: auth.state, lastError: auth.detail, updatedAt: new Date().toISOString() }, env);
    process.stdout.write(`[${provider}] The official CLI could not be opened. Authorization is not complete.\n`);
    return false;
  }

  const confirmed = provider === 'codex' ? true : await confirmUsage(provider);
  if (!confirmed) {
    saveProvider(provider, { state: 'INTERACTION_REQUIRED', updatedAt: new Date().toISOString() }, env);
    process.stdout.write(`[${provider}] Usage verification was not confirmed; nothing was marked ready.\n`);
    return false;
  }

  saveProvider(provider, {
    state: 'CONSENTED',
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
    updatedAt: new Date().toISOString(),
  }, env);
  process.stdout.write(`[${provider}] Setup complete. Automatic read-only monitoring is enabled while the CLI login remains valid.\n`);
  return true;
}

async function run(args, env = process.env) {
  const json = args.includes('--json');
  const filtered = args.filter((arg) => arg !== '--json');
  if (!filtered.length || filtered.includes('--status')) {
    printStatus(json, env);
    return 0;
  }
  const resetIndex = filtered.indexOf('--reset');
  if (resetIndex >= 0) {
    const providers = parseProviderList(filtered.slice(resetIndex + 1));
    if (!providers.length) throw new Error('Usage: statusweave authorize --reset <provider>');
    for (const provider of providers) {
      saveProvider(provider, { consented: false, state: 'CONSENT_REVOKED', revokedAt: new Date().toISOString() }, env);
      process.stdout.write(`[${provider}] StatusWeave monitoring consent revoked. Provider login and folder trust were not changed.\n`);
    }
    return 0;
  }
  const providers = filtered.includes('--all') ? PROVIDERS : parseProviderList(filtered.filter((arg) => arg !== '--all'));
  if (!providers.length) throw new Error('Choose providers or pass --all. Example: statusweave authorize claude,codex');

  process.stdout.write('StatusWeave will open each official CLI in its own empty probe directory.\n');
  process.stdout.write('Existing CLI logins are reused. Only missing or expired CLI logins will open the official login flow.\n');
  process.stdout.write('You personally complete any login, MFA, account selection, and folder trust prompts.\n');
  process.stdout.write('One-time setup stays valid only while that CLI login and output remain compatible.\n');
  let failures = 0;
  for (const provider of providers) if (!(await authorizeProvider(provider, env))) failures++;
  process.stdout.write('\n');
  printStatus(json, env);
  return failures ? 1 : 0;
}

module.exports = {
  PROVIDERS,
  run,
  readState,
  record,
  consentedProviders,
  providerSnapshot,
  probeDir,
  parseProviderList,
  _test: { writeState, saveProvider, authCheck, findExecutable },
};
