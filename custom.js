'use strict';
/**
 * custom.js — user-defined providers ("bring your own monitor").
 *
 * Users describe extra memberships / APIs / machine metrics in
 * ~/.statusweave/providers.json (override with STATUSWEAVE_PROVIDERS).
 * The file is hot-reloaded on mtime change — no restart needed.
 *
 * Two fetch types:
 *   { "type": "http",    "url": ..., "headers": {...} }     → JSON (or text) over HTTP(S)
 *   { "type": "command", "command": "my-cli quota --json" } → stdout, JSON-parsed when possible
 *
 * Two metric kinds:
 *   { "kind": "percent", "label": ..., "path": "$.a.b" | "pattern": "(\\d+)%",
 *     "maxPath": "$.a.max", "resetPath": "$.a.reset_seconds" }  → rendered as a limit bar
 *   { "kind": "value", "label": ..., "path": ..., "unit": " GB" } → rendered as a number row
 *
 * Extraction: dot paths ("$.data.items[0].pct") for JSON, regex with one
 * capture group for plain text.
 *
 * NOTE: specs run with the user's own privileges (local server) — the config
 * file is trusted by definition. Documented in the README.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile, execFileSync } = require('child_process');
const { KEYCHAIN_SERVICE, keychainAccount } = require('./connect');
const MAX_RESPONSE_BYTES = 1024 * 1024;

const CONFIG_PATH =
  process.env.STATUSWEAVE_PROVIDERS || path.join(os.homedir(), '.statusweave', 'providers.json');

/* ---------------- config loading (hot reload by mtime) ---------------- */

let specCache = { mtime: 0, specs: [] };
const runtime = new Map(); // provider ID (or legacy name) → { at, data }

function loadSpecs() {
  let st;
  try {
    st = fs.statSync(CONFIG_PATH);
  } catch {
    return [];
  }
  if (st.mtimeMs !== specCache.mtime) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      specCache = { mtime: st.mtimeMs, specs: Array.isArray(parsed) ? parsed : [] };
    } catch (e) {
      console.error(`Custom providers: failed to parse ${CONFIG_PATH}: ${e.message}`);
      specCache = { mtime: st.mtimeMs, specs: [] };
    }
    runtime.clear(); // spec changed → invalidate per-provider caches
  }
  return specCache.specs.filter((s) => s && s.name && s.type);
}

/* ---------------- extraction helpers ---------------- */

/** Tiny JSON-path lite: "$.a.b[0].c" → value or undefined */
function getPath(obj, expr) {
  if (obj == null || !expr) return undefined;
  const parts = String(expr).replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    const m = p.match(/^([^[\]]+)(?:\[(\d+)\])?$/);
    if (!m) return undefined;
    cur = cur[m[1]];
    if (m[2] !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(m[2])];
    }
  }
  return cur;
}

function extractNumber(metric, raw) {
  if (metric.path) {
    const v = getPath(raw, metric.path);
    return v === undefined || v === null ? undefined : Number(v);
  }
  if (metric.pattern) {
    const m = String(raw).match(new RegExp(metric.pattern));
    return m ? Number(m[1]) : undefined;
  }
  return undefined;
}

function extractValue(metric, raw) {
  if (metric.path) {
    const v = getPath(raw, metric.path);
    return v === undefined || v === null ? undefined : v;
  }
  if (metric.pattern) {
    const m = String(raw).match(new RegExp(metric.pattern));
    return m ? m[1] : undefined;
  }
  return undefined;
}

/* ---------------- fetching ---------------- */

function httpFetch(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: headers || {}, timeout: timeoutMs }, (res) => {
      let body = '';
      let bytes = 0;
      res.on('data', (d) => {
        bytes += d.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          res.destroy();
          return reject(new Error('response too large'));
        }
        body += d;
      });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body); // plain text → regex extraction
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function commandFetch(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', command], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(stdout);
      }
    });
  });
}

function keychainSecret(account) {
  return execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 }
  ).trim();
}

function resolveHeaders(spec, readSecret = keychainSecret) {
  const headers = { ...(spec.headers || {}) };
  if (!spec.auth) return headers;
  if (spec.auth.type !== 'bearer-keychain') throw new Error('unsupported auth type');
  const url = new URL(spec.url);
  if (url.protocol !== 'https:' || spec.auth.origin !== url.origin) throw new Error('auth origin mismatch');
  const secret = readSecret(keychainAccount(spec.id, url.origin));
  if (!secret) throw new Error('missing keychain secret');
  headers.Authorization = `Bearer ${secret}`;
  return headers;
}

/* ---------------- normalize into the shared provider shape ---------------- */

function normalize(spec, raw) {
  const windows = [];
  const rows = [];
  for (const m of spec.metrics || []) {
    if (m.kind === 'percent') {
      let pct = extractNumber(m, raw);
      if (pct === undefined || Number.isNaN(pct)) continue;
      if (m.maxPath) {
        const max = Number(getPath(raw, m.maxPath));
        if (max > 0) pct = (pct / max) * 100;
      }
      const w = { key: 'custom', label: m.label || 'usage', pct: Math.max(0, Math.min(100, Math.round(pct))) };
      if (m.resetPath) {
        const rs = Number(getPath(raw, m.resetPath));
        if (rs > 0) w.resetAfterSeconds = rs;
      }
      windows.push(w);
    } else {
      const v = extractValue(m, raw);
      if (v === undefined) continue;
      rows.push({ label: m.label || 'value', value: String(v) + (m.unit || '') });
    }
  }
  return {
    provider: spec.name,
    detected: true,
    custom: true,
    plan: windows.length ? { tier: spec.tier || 'custom', windows } : null,
    rows,
    hint: windows.length || rows.length ? undefined : 'no metrics matched — check path/pattern',
  };
}

/* ---------------- collect with per-provider interval caching ---------------- */

async function collect() {
  const specs = loadSpecs();
  const out = [];
  for (const spec of specs) {
    const cacheKey = spec.id || spec.name;
    const interval = Math.max(30, spec.interval || 600) * 1000;
    const rt = runtime.get(cacheKey);
    if (rt && Date.now() - rt.at < interval) {
      out.push(rt.data);
      continue;
    }
    let data;
    try {
      const raw =
        spec.type === 'http'
          ? await httpFetch(spec.url, resolveHeaders(spec), 8000)
          : await commandFetch(spec.command, 10000);
      data = normalize(spec, raw);
    } catch {
      // Do not return child-process errors: they can contain the command and embedded secrets.
      data = { provider: spec.name, detected: true, custom: true, hint: 'fetch failed' };
    }
    runtime.set(cacheKey, { at: Date.now(), data });
    out.push(data);
  }
  return out;
}

module.exports = { collect, _test: { resolveHeaders } };
