'use strict';
/**
 * AI plan/CLI usage collection — local log statistics + unofficial plan-limit integrations.
 * Disabled by default. Enable providers with --enable-ai or STATUSWEAVE_AI_PROVIDERS.
 *
 * - Claude Code:
 *   · Stats: parse .jsonl session logs under ~/.claude/projects (same approach as ccusage)
 *   · Limits: Keychain "Claude Code-credentials" → https://api.anthropic.com/api/oauth/usage
 *     (the first Keychain read triggers a system prompt; choose "Always Allow" to skip it later)
 * - Codex CLI:
 *   · Stats: parse .jsonl session logs under ~/.codex/sessions
 *   · Limits: ~/.codex/auth.json → https://chatgpt.com/backend-api/codex/usage
 * - Kimi Code (v2):
 *   · Stats: parse wire.jsonl session logs under ~/.kimi-code/sessions
 *   · Limits: ~/.kimi-code/credentials/kimi-code.json → https://api.kimi.com/coding/v1/usages
 *     (expired OAuth tokens are refreshed via https://auth.kimi.com/api/oauth/token
 *     and written back, exactly as the Kimi CLI does)
 *   · Kimi v1 fallback: pseudo-TTY scraping of the interactive /status output
 *
 * server.js calls collectUsage() every 10 minutes
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync, spawn } = require('child_process');
const custom = require('./custom');
const authorization = require('./authorization');

const DAY = 24 * 3600 * 1000;
const MAX_AGE = 35 * DAY;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const BUILTIN_PROVIDERS = ['claude', 'codex', 'kimi'];

/* ================= Common helpers ================= */

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function recentFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  return walk(dir).filter((f) => {
    try {
      return now - fs.statSync(f).mtimeMs < MAX_AGE;
    } catch {
      return false;
    }
  });
}

function blankTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}
function dayStart() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
}
function monthStart() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), 1).getTime();
}
function dateKey(ts) {
  const d = new Date(ts);
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  );
}
function last7DayBuckets() {
  const n = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - i);
    days.push({
      key: dateKey(d.getTime()),
      date: `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`,
      total: 0,
      output: 0,
    });
  }
  return days;
}

function httpsGetJson(hostname, urlPath, headers, timeout = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = https.get({ hostname, path: urlPath, headers, timeout }, (res) => {
      let body = '';
      let bytes = 0;
      res.on('data', (d) => {
        bytes += d.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          res.destroy();
          return finish(null);
        }
        body += d;
      });
      res.on('end', () => {
        try {
          finish({ status: res.statusCode, json: JSON.parse(body) });
        } catch {
          finish({ status: res.statusCode, json: null });
        }
      });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });
  });
}

function httpsPostForm(hostname, urlPath, form, headers = {}, timeout = 8000) {
  return new Promise((resolve) => {
    const body = new URLSearchParams(form).toString();
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
          ...headers,
        },
        timeout,
      },
      (res) => {
        let text = '';
        let bytes = 0;
        res.on('data', (d) => {
          bytes += d.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            res.destroy();
            return finish(null);
          }
          text += d;
        });
        res.on('end', () => {
          try {
            finish({ status: res.statusCode, json: JSON.parse(text) });
          } catch {
            finish({ status: res.statusCode, json: null });
          }
        });
      }
    );
    req.on('error', () => finish(null));
    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });
    req.end(body);
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function enabledProviders(argv = process.argv.slice(2), env = process.env) {
  const equalsArg = argv.find((a) => a.startsWith('--enable-ai='));
  const flagIndex = argv.indexOf('--enable-ai');
  const raw = equalsArg
    ? equalsArg.slice('--enable-ai='.length)
    : flagIndex >= 0
      ? argv[flagIndex + 1] || ''
      : env.STATUSWEAVE_AI_PROVIDERS || '';
  const selected = new Set(
    raw
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter((s) => BUILTIN_PROVIDERS.includes(s))
  );
  if (env === process.env || env.STATUSWEAVE_STATE_DIR) {
    for (const provider of authorization.consentedProviders(env)) selected.add(provider);
  }
  return selected;
}

function disabledProvider(name) {
  const saved = authorization.record(name);
  const authorizationState = saved?.state === 'CONSENT_REVOKED' ? 'CONSENT_REVOKED' : 'NOT_CONFIGURED';
  return {
    provider: name[0].toUpperCase() + name.slice(1),
    detected: false,
    enabled: false,
    authorizationState,
    hint: `Run statusweave authorize ${name} to enable read-only CLI usage monitoring`,
  };
}

/* ================= Claude Code ================= */

let claudeCredsCache = null;
let claudeVersionCache = null;

function claudeCreds() {
  // credentials live in macOS Keychain; cache to avoid repeated reads
  if (claudeCredsCache && claudeCredsCache.expiresAt > Date.now() + 60000) {
    return claudeCredsCache;
  }
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    claudeCredsCache = JSON.parse(out).claudeAiOauth;
    return claudeCredsCache;
  } catch {
    return null;
  }
}

// Public OAuth client id used by Claude Code itself (visible in the CLI bundle).
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';

/**
 * Refresh an expired/expiring Claude OAuth token the same way Claude Code does:
 * POST the refresh token to Anthropic's token endpoint, then write the rotated
 * credential set back to the SAME Keychain item. Writing back is mandatory —
 * refresh tokens rotate, so consuming one without persisting the new pair would
 * break the CLI's own next refresh.
 */
function claudeRefreshCreds(creds) {
  if (!creds || !creds.refreshToken) return null;
  if (creds.refreshTokenExpiresAt && creds.refreshTokenExpiresAt < Date.now()) return null;
  let r;
  try {
    r = JSON.parse(execFileSync('/usr/bin/curl', [
      '--silent', '--show-error', '--max-time', '10',
      '--user-agent', `claude-code/${claudeCliVersion()}`,
      '--request', 'POST',
      '--header', 'Content-Type: application/json',
      '--header', 'Accept: application/json',
      '--data', '@-',
      CLAUDE_TOKEN_URL,
    ], {
      input: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
      timeout: 15000,
      encoding: 'utf8',
      maxBuffer: MAX_RESPONSE_BYTES,
      stdio: ['pipe', 'pipe', 'ignore'],
    }));
  } catch {
    return null;
  }
  if (!r || typeof r.access_token !== 'string') return null;
  const updated = {
    ...creds,
    accessToken: r.access_token,
    // Refresh tokens rotate; keep the old one only if the server omits a new one.
    refreshToken: typeof r.refresh_token === 'string' ? r.refresh_token : creds.refreshToken,
    expiresAt: r.expires_in ? Date.now() + Number(r.expires_in) * 1000 : creds.expiresAt,
  };
  persistClaudeCreds(updated);
  claudeCredsCache = updated;
  return updated;
}

/** Merge refreshed fields into the stored Keychain JSON and update the item in place. */
function persistClaudeCreds(updated) {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const full = JSON.parse(raw);
    full.claudeAiOauth = { ...(full.claudeAiOauth || {}), ...updated };
    // The item's account name varies per machine; read it from item metadata
    // (no password access, no prompt) so -U updates the right item.
    const meta = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const acct = meta.match(/"acct"<blob>="([^"]*)"/)?.[1] || '';
    const args = ['add-generic-password', '-U', '-s', 'Claude Code-credentials', '-w', JSON.stringify(full)];
    if (acct) args.push('-a', acct);
    execFileSync('security', args, { timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    // Non-fatal: the in-memory token still works for this fetch.
  }
}

let claudeRefreshInFlight = false;

/** Return credentials with a usable access token, refreshing once when needed. */
function claudeFreshCreds(force = false) {
  const creds = claudeCreds();
  if (!creds) return null;
  const expiringSoon = creds.expiresAt != null && creds.expiresAt < Date.now() + 60000;
  if ((!force && !expiringSoon) || !creds.refreshToken || claudeRefreshInFlight) return creds;
  claudeRefreshInFlight = true;
  try {
    return claudeRefreshCreds(creds) || creds;
  } finally {
    claudeRefreshInFlight = false;
  }
}

async function claudePlan() {
  let creds = claudeFreshCreds();
  if (!creds || !creds.accessToken) return null;
  // Anthropic's edge currently rejects some Node TLS fingerprints with 403
  // even when the same valid OAuth token works in Claude Code. Use macOS curl
  // with a Claude Code user-agent. The token travels through stdin config, so
  // it is never exposed in argv or returned by StatusWeave's API.
  let r = claudeUsageViaCurl(creds.accessToken);
  if (!r) {
    r = await httpsGetJson('api.anthropic.com', '/api/oauth/usage', {
      Authorization: `Bearer ${creds.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'User-Agent': `claude-code/${claudeCliVersion()}`,
    });
  }
  // A 401/429 usually means the stored token went stale between checks:
  // force one refresh + retry before giving up.
  if (r && r.status !== 200 && (r.status === 401 || r.status === 429) && creds.refreshToken) {
    const refreshed = claudeFreshCreds(true);
    if (refreshed && refreshed.accessToken !== creds.accessToken) {
      creds = refreshed;
      r = claudeUsageViaCurl(creds.accessToken);
    }
  }
  if (!r || r.status !== 200 || !r.json) return null;
  return parseClaudePlan(r.json, creds.subscriptionType || null);
}

function claudeCliVersion() {
  if (claudeVersionCache) return claudeVersionCache;
  try {
    const out = execFileSync('claude', ['--version'], {
      timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    claudeVersionCache = String(out).match(/\d+(?:\.\d+)+/)?.[0] || 'statusweave';
  } catch {
    claudeVersionCache = 'statusweave';
  }
  return claudeVersionCache;
}

function curlConfigValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function claudeUsageViaCurl(accessToken) {
  if (/\r|\n/.test(accessToken)) return null;
  const config = [
    `header = "Authorization: Bearer ${curlConfigValue(accessToken)}"`,
    'header = "anthropic-beta: oauth-2025-04-20"',
    'header = "anthropic-version: 2023-06-01"',
    'header = "Accept: application/json"',
  ].join('\n');
  try {
    const out = execFileSync('/usr/bin/curl', [
      '--silent', '--show-error', '--max-time', '10',
      '--user-agent', `claude-code/${claudeCliVersion()}`,
      '--write-out', '\n%{http_code}', '--config', '-',
      'https://api.anthropic.com/api/oauth/usage',
    ], {
      input: config,
      timeout: 15000,
      encoding: 'utf8',
      maxBuffer: MAX_RESPONSE_BYTES,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const split = out.lastIndexOf('\n');
    if (split < 0) return null;
    return { status: Number(out.slice(split + 1)), json: JSON.parse(out.slice(0, split)) };
  } catch {
    return null;
  }
}

function parseClaudePlan(j, tier = null) {
  if (Array.isArray(j.limits) && j.limits.length) {
    const windows = j.limits.filter((limit) => limit && limit.percent != null).map((limit) => {
      const model = limit.scope?.model?.display_name;
      if (limit.kind === 'session') {
        return { key: '5h', label: 'Session limit', pct: Math.round(limit.percent), resetsAt: limit.resets_at || null };
      }
      if (limit.kind === 'weekly_all') {
        return { key: 'weekly', label: 'Weekly limit', pct: Math.round(limit.percent), resetsAt: limit.resets_at || null };
      }
      return {
        key: model ? `weekly-${String(model).toLowerCase()}` : String(limit.kind || 'limit'),
        label: model ? `Weekly ${model} limit` : String(limit.kind || 'Limit').replace(/_/g, ' '),
        pct: Math.round(limit.percent),
        resetsAt: limit.resets_at || null,
      };
    });
    if (windows.length) return { tier, windows };
  }
  const win = (key, label, w) =>
    w && w.utilization != null ? { key, label, pct: Math.round(w.utilization), resetsAt: w.resets_at || null } : null;
  const windows = [
    win('5h', '5h limit', j.five_hour),
    win('weekly', 'Weekly limit', j.seven_day),
    win('weekly', 'Weekly Opus limit', j.seven_day_opus),
    win('weekly', 'Weekly Sonnet limit', j.seven_day_sonnet),
  ].filter(Boolean);
  return { tier, windows };
}

async function claudeUsage() {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(dir)) {
    return { provider: 'Claude', detected: false, hint: '~/.claude not detected (auto-enabled after installing and logging into Claude Code)' };
  }
  const files = recentFiles(dir);
  const today = blankTokens();
  const month = blankTokens();
  const last5h = blankTokens();
  const dStart = dayStart();
  const mStart = monthStart();
  const fiveHAgo = Date.now() - 5 * 3600 * 1000;
  const days = last7DayBuckets();
  const dayMap = new Map(days.map((d) => [d.key, d]));
  const sessions = new Set();
  let requests = 0;

  const tokensOf = (u) =>
    (u.input_tokens || 0) + (u.output_tokens || 0) +
    (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const add = (acc, u) => {
    acc.input += u.input_tokens || 0;
    acc.output += u.output_tokens || 0;
    acc.cacheRead += u.cache_read_input_tokens || 0;
    acc.cacheWrite += u.cache_creation_input_tokens || 0;
    acc.total += tokensOf(u);
  };

  for (const f of files) {
    let lines;
    try {
      lines = fs.readFileSync(f, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const u = obj.message && obj.message.usage;
      const ts = Date.parse(obj.timestamp || '');
      if (!u || !ts) continue;
      requests++;
      sessions.add(path.basename(f, '.jsonl'));
      if (ts >= mStart) add(month, u);
      if (ts >= dStart) add(today, u);
      if (ts >= fiveHAgo) add(last5h, u);
      const dd = dayMap.get(dateKey(ts));
      if (dd) {
        dd.total += tokensOf(u);
        dd.output += u.output_tokens || 0;
      }
    }
  }

  const plan = await claudePlan().catch(() => null);
  return {
    provider: 'Claude',
    detected: true,
    today,
    last5h,
    month,
    history: days.map(({ date, total, output }) => ({ date, total, output })),
    requests,
    sessions: sessions.size,
    plan,
  };
}

/* ================= Codex CLI ================= */

async function codexPlan() {
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
  } catch {
    return null;
  }
  const t = auth.tokens || {};
  if (!t.access_token) return null;
  // chatgpt.com TLS resets are common on some networks; retry a couple of
  // times on transport failure (null) — never retry on an HTTP answer.
  let r = null;
  for (let attempt = 0; attempt < 3 && !r; attempt++) {
    r = await httpsGetJson('chatgpt.com', '/backend-api/codex/usage', {
      Authorization: `Bearer ${t.access_token}`,
      'chatgpt-account-id': t.account_id || '',
      'User-Agent': 'codex_cli_rs/0.148.0',
      originator: 'codex_cli_rs',
      Accept: 'application/json',
    });
    if (!r && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800));
  }
  if (!r || !r.json || r.status !== 200) return null;
  return parseCodexPlan(r.json);
}

function parseCodexPlan(j) {
  const rl = j.rate_limit || {};
  const windowFor = (secs) =>
    secs >= 604800
      ? { key: 'weekly', label: 'Weekly limit' }
      : secs >= 18000
        ? { key: '5h', label: '5h limit' }
        : { key: `${Math.round(secs / 3600)}h`, label: `${Math.round(secs / 3600)}h limit` };
  const win = (w) =>
    w && w.used_percent != null
      ? {
          ...windowFor(w.limit_window_seconds || 0),
          pct: w.used_percent,
          resetAfterSeconds: w.reset_after_seconds ?? null,
          resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
        }
      : null;
  const windows = [win(rl.primary_window), win(rl.secondary_window)].filter(Boolean);
  return { tier: j.plan_type || null, windows };
}

async function codexUsage() {
  const dir = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(dir)) {
    return { provider: 'Codex', detected: false, hint: '~/.codex/sessions not detected (auto-enabled after logging into Codex CLI)' };
  }
  const files = recentFiles(dir);
  const today = blankTokens();
  const month = blankTokens();
  const dStart = dayStart();
  const mStart = monthStart();
  const days = last7DayBuckets();
  const dayMap = new Map(days.map((d) => [d.key, d]));
  let sessions = 0;

  for (const f of files) {
    const dm = f.match(/rollout-(\d{4})-(\d{2})-(\d{2})/);
    const fileDay = dm ? new Date(+dm[1], +dm[2] - 1, +dm[3]).getTime() : null;
    let content;
    try {
      content = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    let last = null;
    const re = /"total_token_usage":\{([^}]*)\}/g;
    let mm;
    while ((mm = re.exec(content))) last = mm[1];
    if (!last) continue;
    const get = (k) => {
      const r = last.match(new RegExp(`"${k}":(\\d+)`));
      return r ? Number(r[1]) : 0;
    };
    sessions++;
    const entry = {
      input: get('input_tokens'),
      output: get('output_tokens'),
      cacheRead: get('cached_input_tokens'),
      total: get('total_tokens'),
    };
    if (fileDay == null) continue;
    for (const [acc, start] of [[month, mStart], [today, dStart]]) {
      if (fileDay >= start) {
        acc.input += entry.input;
        acc.output += entry.output;
        acc.cacheRead += entry.cacheRead;
        acc.total += entry.total;
      }
    }
    const dd = dayMap.get(dateKey(fileDay));
    if (dd) {
      dd.total += entry.total;
      dd.output += entry.output;
    }
  }

  const plan = await codexPlan().catch(() => null);
  return {
    provider: 'Codex',
    detected: true,
    today,
    month,
    history: days.map(({ date, total, output }) => ({ date, total, output })),
    sessions,
    plan,
  };
}

/* ================= Kimi Code ================= */
/**
 * Kimi has no externally readable credentials (login state is encrypted and managed),
 * but the interactive CLI's /status shows Plan usage. We use `script` to allocate a
 * pseudo-TTY, inject /status + Enter with delays, then parse limit percentages and
 * reset times from the rendered output. No authorization needed.
 */

function kimiBin() {
  if (process.env.KIMI_BIN && fs.existsSync(process.env.KIMI_BIN)) return process.env.KIMI_BIN;
  // Reuse the shared resolver so collection finds the same CLI that
  // authorization found (PATH lookup plus well-known install locations).
  return authorization.findExecutable('kimi');
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '');
}

function parseResetSeconds(text) {
  let secs = 0;
  const d = text.match(/(\d+)\s*d/);
  const h = text.match(/(\d+)\s*h/);
  const m = text.match(/(\d+)\s*m(?!s)/);
  if (d) secs += Number(d[1]) * 86400;
  if (h) secs += Number(h[1]) * 3600;
  if (m) secs += Number(m[1]) * 60;
  return secs || null;
}

function parseKimiStatus(raw) {
  // pty width is unstable and may cause line wraps; collapse all whitespace before matching
  const flat = stripAnsi(raw).replace(/\s+/g, ' ');
  const windows = [];
  const re = /([A-Za-z0-9 ]*?limit)\s+[^0-9]*?(\d+)\s*%\s*used\s+resets in\s+([0-9dhms ]+?)(?:\s+[│|]|$|\s{2,})/gi;
  let m;
  while ((m = re.exec(flat))) {
    let label = m[1].trim();
    let key = null;
    if (/weekly/i.test(label)) { key = 'weekly'; label = 'Weekly limit'; }
    else if (/5h/i.test(label)) { key = '5h'; label = '5h limit'; }
    windows.push({
      key: key || label.toLowerCase().replace(/\s+/g, '-'),
      label,
      pct: Number(m[2]),
      resetAfterSeconds: m[3] ? parseResetSeconds(m[3]) : null,
    });
  }
  return windows.length ? { tier: 'kimi-code', windows } : null;
}

let kimiInFlight = false;

function kimiPlanOnce(logFile) {
  return new Promise((resolve) => {
    const bin = kimiBin();
    // macOS `script` only reliably records pty output when writing to a log file,
    // and its stdin must be a real pipe (Node spawn stdio pipes are sockets and fail),
    // so use a bash pipeline to inject /status + Enter with delays
    const cmd =
      `( sleep 7; printf '/status\\r'; sleep 7; printf '/exit\\r'; sleep 1 ) | ` +
      `script -q ${shellQuote(logFile)} ${shellQuote(bin)} >/dev/null 2>&1`;
    let child;
    try {
      // After visible one-time authorization, reuse the dedicated directory the
      // user trusted. Legacy --enable-ai runs keep the previous home-directory behavior.
      const consent = authorization.record('kimi');
      const cwd = consent?.consented ? authorization.probeDir('kimi') : os.homedir();
      child = spawn('bash', ['-c', cmd], { stdio: 'ignore', cwd });
    } catch {
      return resolve(false);
    }
    const killer = setTimeout(() => child.kill('SIGTERM'), 20000);
    child.on('close', () => {
      clearTimeout(killer);
      let ok = false;
      try {
        ok =
          fs.existsSync(logFile) &&
          /%\s*used/.test(fs.readFileSync(logFile, 'utf8').replace(/\s+/g, ' '));
      } catch {}
      resolve(ok);
    });
    child.on('error', () => {
      clearTimeout(killer);
      resolve(false);
    });
  });
}

/* ---- Kimi v2: direct HTTP usage fetch (default since CLI 2.0) ---- */
// Kimi Code 2.x stores OAuth credentials in plaintext and fetches plan usage
// over HTTP itself, so we do exactly the same — far more reliable than scraping
// a pseudo-TTY, which also broke when newer macOS versions restricted openpty.
// Client id/host are public constants from the Kimi Code CLI bundle.
const KIMI_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMI_DEFAULT_BASE_URLS = ['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1'];

function kimiCredsFile() {
  return path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json');
}

function kimiCreds() {
  try {
    const creds = JSON.parse(fs.readFileSync(kimiCredsFile(), 'utf8'));
    return creds && creds.access_token ? creds : null;
  } catch {
    return null;
  }
}

/** The managed provider's base URL from config.toml, then the built-in defaults. */
function kimiBaseUrls(env = process.env) {
  const urls = [];
  try {
    const toml = fs.readFileSync(path.join(os.homedir(), '.kimi-code', 'config.toml'), 'utf8');
    const managed = toml.match(/\[providers\."managed:kimi-code"\]([^\[]*)/);
    const base = managed && managed[1].match(/base_url\s*=\s*"([^"]+)"/);
    if (base) urls.push(base[1].replace(/\/+$/, ''));
  } catch {}
  if (env.KIMI_CODE_BASE_URL) urls.push(env.KIMI_CODE_BASE_URL.replace(/\/+$/, ''));
  for (const u of KIMI_DEFAULT_BASE_URLS) urls.push(u);
  return [...new Set(urls)];
}

/** Refresh an expired token via the Kimi OAuth host and persist the rotated set. */
async function kimiRefreshCreds(creds) {
  if (!creds.refresh_token) return null;
  const r = await httpsPostForm(new URL(KIMI_OAUTH_HOST).hostname, '/api/oauth/token', {
    client_id: KIMI_OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
  });
  if (!r || r.status !== 200 || !r.json || typeof r.json.access_token !== 'string') return null;
  const updated = {
    ...creds,
    access_token: r.json.access_token,
    // Preserve the original refresh token if a new one is not returned.
    refresh_token: typeof r.json.refresh_token === 'string' ? r.json.refresh_token : creds.refresh_token,
    expires_at: r.json.expires_in
      ? Math.floor(Date.now() / 1000) + Number(r.json.expires_in)
      : creds.expires_at,
  };
  try {
    fs.writeFileSync(kimiCredsFile(), JSON.stringify(updated, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal: the in-memory token still works for this fetch.
  }
  return updated;
}

function kimiTokenExpired(creds) {
  const expMs = Number(creds.expires_at || 0) * (Number(creds.expires_at) < 1e12 ? 1000 : 1);
  return !expMs || expMs < Date.now() + 60000;
}

function parseKimiUsages(j) {
  const usages = (j && j.usages) || {};
  const win = (key, label, e) =>
    e && e.used_ratio != null
      ? { key, label, pct: Math.round(Number(e.used_ratio) * 100), resetsAt: e.reset_time || null }
      : null;
  const windows = [
    win('5h', '5h limit', usages.limit_5h),
    win('weekly', 'Weekly limit', usages.limit_7d),
  ].filter(Boolean);
  return windows.length ? { tier: 'kimi-code', windows } : null;
}

async function kimiPlanViaApi() {
  let creds = kimiCreds();
  if (!creds) return null;
  if (kimiTokenExpired(creds) && creds.refresh_token) {
    creds = (await kimiRefreshCreds(creds).catch(() => null)) || creds;
  }
  for (const base of kimiBaseUrls()) {
    const url = new URL(`${base}/usages`);
    let r = await httpsGetJson(url.hostname, url.pathname, {
      Authorization: `Bearer ${creds.access_token}`,
    });
    if (r && r.status === 401 && creds.refresh_token) {
      const refreshed = await kimiRefreshCreds(creds).catch(() => null);
      if (refreshed) {
        creds = refreshed;
        r = await httpsGetJson(url.hostname, url.pathname, {
          Authorization: `Bearer ${creds.access_token}`,
        });
      }
    }
    if (r && r.status === 200 && r.json) {
      const plan = parseKimiUsages(r.json);
      if (plan) return plan;
    }
    // 404 means this base URL does not serve managed usage; try the next one.
  }
  return null;
}

async function kimiPlan() {
  // Kimi v2 stores readable OAuth credentials — go straight to the HTTP API.
  // Only fall back to the legacy pty scrape for v1 installs (no creds file).
  if (fs.existsSync(kimiCredsFile())) {
    return kimiPlanViaApi();
  }
  const bin = kimiBin();
  if (!bin || kimiInFlight) return null;
  kimiInFlight = true;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const logFile = path.join(os.tmpdir(), `statusweave-kimi-${process.pid}-${Date.now()}.log`);
      const ok = await kimiPlanOnce(logFile);
      let out = null;
      if (ok) {
        try {
          out = parseKimiStatus(fs.readFileSync(logFile, 'utf8'));
        } catch {}
      }
      fs.unlink(logFile, () => {});
      if (out) return out;
      console.error(`Kimi /status collection attempt ${attempt + 1} missed, ${attempt === 0 ? 'retrying…' : 'giving up (will retry on next refresh)'}`);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  } finally {
    kimiInFlight = false;
  }
}

/**
 * Kimi session token stats: read ~/.kimi-code/sessions/<workspace>/<session>/agents/main/wire.jsonl
 * The last "usage" in each file is that session's cumulative total, bucketed into today/this month
 * by file modification date.
 */
function kimiLogStats() {
  const root = path.join(os.homedir(), '.kimi-code', 'sessions');
  if (!fs.existsSync(root)) return null;
  const files = recentFiles(root).filter((f) => f.endsWith('wire.jsonl'));
  const today = blankTokens();
  const month = blankTokens();
  const dStart = dayStart();
  const mStart = monthStart();
  const days = last7DayBuckets();
  const dayMap = new Map(days.map((d) => [d.key, d]));
  let sessions = 0;
  const addEntry = (acc, e) => {
    acc.input += e.input;
    acc.output += e.output;
    acc.cacheRead += e.cacheRead;
    acc.cacheWrite += e.cacheWrite;
    acc.total += e.total;
  };
  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    let last = null;
    const re = /"usage":\{([^}]*)\}/g;
    let mm;
    while ((mm = re.exec(content))) last = mm[1];
    if (!last) continue;
    const get = (k) => {
      const r = last.match(new RegExp(`"${k}":(\\d+)`));
      return r ? Number(r[1]) : 0;
    };
    const entry = blankTokens();
    entry.input = get('inputOther');
    entry.output = get('output');
    entry.cacheRead = get('inputCacheRead');
    entry.cacheWrite = get('inputCacheCreation');
    entry.total = entry.input + entry.output + entry.cacheRead + entry.cacheWrite;
    if (!entry.total) continue;
    sessions++;
    let mtime;
    try {
      mtime = fs.statSync(f).mtime;
    } catch {
      continue;
    }
    const dayMs = new Date(mtime.getFullYear(), mtime.getMonth(), mtime.getDate()).getTime();
    if (dayMs >= mStart) addEntry(month, entry);
    if (dayMs >= dStart) addEntry(today, entry);
    const dd = dayMap.get(dateKey(mtime.getTime()));
    if (dd) {
      dd.total += entry.total;
      dd.output += entry.output;
    }
  }
  return {
    today,
    month,
    sessions,
    history: days.map(({ date, total, output }) => ({ date, total, output })),
  };
}

async function kimiUsage() {
  if (!kimiBin()) {
    return { provider: 'Kimi', detected: false, hint: 'Kimi Code CLI not detected (auto-enabled once installed)' };
  }
  const stats = kimiLogStats();
  const plan = await kimiPlan().catch(() => null);
  return {
    provider: 'Kimi',
    detected: true,
    today: stats ? stats.today : undefined,
    month: stats ? stats.month : undefined,
    history: stats ? stats.history : undefined,
    sessions: stats ? stats.sessions : 0,
    plan,
    hint: plan ? undefined : 'Plan limits unavailable yet (retrying on next refresh)',
  };
}

/* ================= Aggregate ================= */

// Stale-if-error: keep the last successfully fetched plan per provider so a
// transient failure (token expiry, Cloudflare hiccup, pty miss) never blanks a card.
const planCache = new Map();
const PLAN_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cachedPlanAt(entry, now) {
  const ageMs = Math.max(0, now - entry.cachedAt);
  if (ageMs > PLAN_CACHE_MAX_AGE_MS) return null;
  const ageSeconds = Math.floor(ageMs / 1000);
  const windows = entry.plan.windows.map((window) => {
    const cached = { ...window };
    if (cached.resetAfterSeconds != null) {
      cached.resetAfterSeconds = Math.max(0, cached.resetAfterSeconds - ageSeconds);
    }
    return cached;
  }).filter((window) => {
    if (window.resetAfterSeconds != null) return window.resetAfterSeconds > 0;
    if (window.resetsAt) {
      const resetAt = Date.parse(window.resetsAt);
      return !Number.isFinite(resetAt) || resetAt > now;
    }
    return true;
  });
  return windows.length ? { ...entry.plan, windows } : null;
}

function withPlanCache(p, now = Date.now(), cache = planCache) {
  if (!p) return p;
  if (p.plan && p.plan.windows && p.plan.windows.length) {
    cache.set(p.provider, {
      cachedAt: now,
      plan: { ...p.plan, windows: p.plan.windows.map((window) => ({ ...window })) },
    });
  } else if (p.detected !== false && !/auth|login|unauthor|credential/i.test(p.error || '') && cache.has(p.provider)) {
    const entry = cache.get(p.provider);
    const cached = cachedPlanAt(entry, now);
    if (cached) {
      p.plan = { ...cached, tier: p.plan?.tier || cached.tier };
      p.planStale = true;
      p.planCachedAt = entry.cachedAt;
    } else {
      cache.delete(p.provider);
    }
  }
  return p;
}

function withAuthorizationState(p, name) {
  if (!p) return p;
  const saved = authorization.record(name);
  if (p.authorizationState) return p;
  if (p.enabled === false) {
    p.authorizationState = saved?.state === 'CONSENT_REVOKED' ? 'CONSENT_REVOKED' : 'NOT_CONFIGURED';
  } else if (p.error && /auth|login|unauthor|credential/i.test(p.error)) {
    p.authorizationState = 'AUTH_REQUIRED';
  } else if (!p.detected) {
    p.authorizationState = saved?.consented ? 'AUTH_REQUIRED' : 'NOT_CONFIGURED';
  } else if (p.plan?.windows?.length) {
    p.authorizationState = 'READY_WITH_LIMITS';
  } else if (p.hint && /limit.*unavailable/i.test(p.hint)) {
    p.authorizationState = 'LIMIT_UNAVAILABLE';
  } else if (p.plan && Array.isArray(p.plan.windows) && !p.plan.windows.length) {
    p.authorizationState = 'LIMIT_UNAVAILABLE';
  } else {
    p.authorizationState = 'READY_USAGE_ONLY';
  }
  p.authorization = {
    consented: saved?.consented === true,
    lastVerifiedAt: saved?.lastVerifiedAt || null,
  };
  return p;
}

async function collectUsage(options = {}) {
  const enabled = options.enabled || enabledProviders();
  const collectors = { claude: claudeUsage, codex: codexUsage, kimi: kimiUsage };
  const enableCustom = options.enableCustom ?? process.env.STATUSWEAVE_ENABLE_CUSTOM === '1';
  const [builtin, customProviders] = await Promise.all([
    Promise.all(
      BUILTIN_PROVIDERS.map((name) =>
        enabled.has(name) ? collectors[name]().catch(() => null) : disabledProvider(name)
      )
    ),
    enableCustom ? custom.collect().catch(() => []) : [],
  ]);
  return {
    timestamp: Date.now(),
    refreshInterval: 600,
    providers: [
      ...builtin.map((provider, index) => provider && withAuthorizationState(withPlanCache(provider), BUILTIN_PROVIDERS[index])).filter(Boolean),
      ...customProviders,
    ],
  };
}

module.exports = {
  collectUsage,
  enabledProviders,
  _test: { parseClaudePlan, parseCodexPlan, parseKimiStatus, parseKimiUsages, kimiBaseUrls, shellQuote, withPlanCache },
};
