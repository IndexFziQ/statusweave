#!/usr/bin/env node
/**
 * system-monitor — local system monitoring service
 * Zero dependencies (Node.js >= 18), provides REST API + visual dashboard
 *
 * Usage:
 *   node src/server.js          # default port 8787
 *   PORT=9000 node src/server.js
 *
 * API:
 *   GET /api/stats      all metrics (cpu/memory/swap/disk/load/processes...)
 *   GET /api/cpu        CPU only
 *   GET /api/memory     memory only
 *   GET /api/processes  process list only
 *   GET /api/health     health check
 *   GET /               visual dashboard
 */
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const usage = require('./usage');
const httpSecurity = require('./http-security');
const feedback = require('./feedback');
const { openDashboard } = require('./open-dashboard');

const PORT = Number(process.env.PORT || 8787);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  fs.writeSync(process.stderr.fd, 'PORT must be an integer from 1 to 65535\n');
  process.exit(1);
}
// Bind to loopback only by default (metrics include processes/AI usage — do not
// expose to the LAN). Set STATUSWEAVE_HOST=0.0.0.0 to allow remote access.
const HOST = process.env.STATUSWEAVE_HOST || '127.0.0.1';
// CORS is only needed for browser-based apps on a *different* origin; native
// apps and coding agents don't need it. Set STATUSWEAVE_CORS=* (or an origin) to enable.
const CORS = process.env.STATUSWEAVE_CORS || '';
const STARTUP_AI_PROVIDERS = usage.enabledProviders();
const CUSTOM_ENABLED = process.env.STATUSWEAVE_ENABLE_CUSTOM === '1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SAMPLE_INTERVAL = 1000; // sample once per second; the API serves the latest snapshot

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`StatusWeave

Usage:
  statusweave                         Start and open the local dashboard
  statusweave --no-open               Start without opening a browser
  statusweave authorize [claude,codex,kimi|--all|--status]
  statusweave doctor|detect|launch|verify [--json]
  statusweave connect <id> --path <json-path>
  statusweave disconnect <id>

Options:
  authorize           One-time visible setup for official CLI login and monitoring consent
  --no-open           Keep the dashboard in this terminal without opening a browser
  --enable-ai <list>  Explicitly enable credential/session access for selected AI CLIs
  -h, --help          Show this help

Environment:
  STATUSWEAVE_AI_PROVIDERS=claude,codex,kimi
  STATUSWEAVE_ENABLE_CUSTOM=1
  PORT=8787  STATUSWEAVE_HOST=127.0.0.1  STATUSWEAVE_CORS=<origin>`);
  process.exit(0);
}

const REMOTE = !['127.0.0.1', '::1', 'localhost'].includes(HOST);
if (REMOTE && (STARTUP_AI_PROVIDERS.size || CUSTOM_ENABLED) && process.env.STATUSWEAVE_ALLOW_REMOTE !== '1') {
  console.error('Refusing to expose AI/custom usage remotely. Set STATUSWEAVE_ALLOW_REMOTE=1 only if you accept the risk.');
  process.exit(1);
}

// Local dashboards pick up completed authorize/reset changes without a server
// restart. Remote bindings stay pinned to the startup allowlist so a later
// local consent change cannot silently expose another provider on the network.
function activeAIProviders() {
  return REMOTE ? STARTUP_AI_PROVIDERS : usage.enabledProviders();
}

/* ---------------- Helpers ---------------- */

function run(cmd, args = [], timeout = 4000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : stdout);
      });
    } catch {
      return resolve(null); // e.g. spawn denied by sandbox
    }
    if (child) child.on('error', () => resolve(null));
  });
}

const round1 = (n) => Math.round(n * 10) / 10;

/* ---------------- CPU ---------------- */

let prevCpuTimes = null;

function sampleCpu() {
  const cpus = os.cpus();
  const now = cpus.map((c) => c.times);
  let perCore;

  if (!prevCpuTimes) {
    // first sample: return average usage since boot
    perCore = now.map((t) => {
      const total = t.user + t.nice + t.sys + t.idle + t.irq;
      return total > 0 ? round1(((t.user + t.nice + t.sys) / total) * 100) : 0;
    });
  } else {
    perCore = now.map((t, i) => {
      const p = prevCpuTimes[i];
      const dTotal =
        t.user - p.user + (t.nice - p.nice) + (t.sys - p.sys) + (t.idle - p.idle) + (t.irq - p.irq);
      const dIdle = t.idle - p.idle;
      return dTotal > 0 ? round1((1 - dIdle / dTotal) * 100) : 0;
    });
  }
  prevCpuTimes = now;

  const overall = round1(perCore.reduce((a, b) => a + b, 0) / (perCore.length || 1));
  return {
    model: cpus[0] ? cpus[0].model.trim() : 'unknown',
    cores: cpus.length,
    overall,
    perCore,
  };
}

/* ---------------- Memory (macOS vm_stat, more accurate than os.freemem) ---------------- */

async function sampleMemory() {
  const total = os.totalmem();
  const out = await run('vm_stat');
  if (out) {
    const psMatch = out.match(/page size of (\d+) bytes/);
    const pageSize = psMatch ? Number(psMatch[1]) : 16384;
    const pages = (name) => {
      const m = out.match(new RegExp(name + ':\\s+(\\d+)'));
      return m ? Number(m[1]) * pageSize : 0;
    };
    const free = pages('Pages free');
    const active = pages('Pages active');
    const inactive = pages('Pages inactive');
    const speculative = pages('Pages speculative');
    const wired = pages('Pages wired down');
    const compressed = pages('Pages occupied by compressor');
    const used = active + wired + compressed;
    const available = free + inactive + speculative;
    return {
      total,
      used,
      available,
      free,
      active,
      inactive,
      wired,
      compressed,
      usedPercent: round1((used / total) * 100),
    };
  }
  // non-macOS fallback
  const available = os.freemem();
  const used = total - available;
  return {
    total, used, available,
    free: available, active: 0, inactive: 0, wired: 0, compressed: 0,
    usedPercent: round1((used / total) * 100),
  };
}

/* ---------------- Swap / Disk ---------------- */

async function sampleSwap() {
  const out = await run('sysctl', ['-n', 'vm.swapusage']);
  if (!out) return null;
  const get = (label) => {
    const m = out.match(new RegExp(label + ' = ([\\d.]+)M'));
    return m ? Number(m[1]) * 1024 * 1024 : 0;
  };
  const total = get('total');
  const used = get('used');
  return { total, used, free: total - used, usedPercent: total > 0 ? round1((used / total) * 100) : 0 };
}

async function sampleDisk() {
  const out = await run('df', ['-k', '/']);
  if (!out) return null;
  const line = out.trim().split('\n').pop();
  const f = line.trim().split(/\s+/);
  const total = Number(f[1]) * 1024;
  const used = Number(f[2]) * 1024;
  const available = Number(f[3]) * 1024;
  return { mount: '/', total, used, available, usedPercent: total > 0 ? round1((used / total) * 100) : 0 };
}

/* ---------------- Processes (top by CPU, requires ps permission) ---------------- */

async function sampleProcesses(limit = 12) {
  const out = await run('ps', ['-Aceo', 'pid=,pcpu=,pmem=,rss=,comm=']);
  if (!out) return [];
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!m) return null;
      return {
        pid: Number(m[1]),
        cpu: Number(m[2]),
        mem: Number(m[3]),
        rss: Number(m[4]) * 1024,
        command: m[5].split('/').pop(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, limit);
}

/* ---------------- App Memory (aggregate RSS by app) ---------------- */

function appName(comm) {
  // /Applications/Google Chrome.app/Contents/MacOS/Google Chrome -> Google Chrome
  const m = comm.match(/\/([^/]+)\.app\/Contents\/MacOS\//);
  if (m) return m[1];
  return comm.split('/').pop();
}

async function sampleApps(limit = 15) {
  const out = await run('ps', ['-Aceo', 'rss=,comm=']);
  if (!out) return [];
  const byApp = new Map();
  for (const line of out.trim().split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const rss = Number(m[1]) * 1024;
    const name = appName(m[2]);
    const e = byApp.get(name) || { name, rss: 0, processes: 0 };
    e.rss += rss;
    e.processes += 1;
    byApp.set(name, e);
  }
  const sorted = [...byApp.values()].sort((a, b) => b.rss - a.rss);
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  if (rest.length) {
    top.push({
      name: `Other (${rest.length})`,
      rss: rest.reduce((a, b) => a + b.rss, 0),
      processes: rest.reduce((a, b) => a + b.processes, 0),
    });
  }
  return top;
}

/* ---------------- GPU (Apple Silicon, via IORegistry PerformanceStatistics — no sudo) ---------------- */

async function sampleGpu() {
  const out = await run('ioreg', ['-rc', 'AGXAccelerator']);
  if (!out) return null;
  const grab = (key) => {
    const m = out.match(new RegExp(`"${key}"=(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const utilization = grab('Device Utilization %');
  if (utilization == null) return null;
  return {
    utilization,
    renderer: grab('Renderer Utilization %'),
    tiler: grab('Tiler Utilization %'),
    memUsed: grab('In use system memory'),
    memAlloc: grab('Alloc system memory'),
  };
}

/* ---------------- Periodic collection; API only reads the latest snapshot (consumers don't interfere) ---------------- */

const latest = {
  timestamp: Date.now(),
  host: {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptime: os.uptime(),
  },
  cpu: null,
  gpu: null,
  load: os.loadavg(),
  memory: null,
  swap: null,
  disk: null,
  processes: [],
  apps: [],
  usage: null,
};

async function collect() {
  // CPU/load/uptime use built-in Node APIs — no subprocesses, always available
  latest.timestamp = Date.now();
  latest.host.uptime = os.uptime();
  latest.cpu = sampleCpu();
  latest.load = os.loadavg();
  try {
    const safe = (p) => p.catch(() => null);
    const [memory, swap, disk, gpu, processes, apps] = await Promise.all([
      safe(sampleMemory()),
      safe(sampleSwap()),
      safe(sampleDisk()),
      safe(sampleGpu()),
      safe(sampleProcesses()),
      safe(sampleApps()),
    ]);
    if (memory) latest.memory = memory;
    if (swap) latest.swap = swap;
    if (disk) latest.disk = disk;
    if (gpu) latest.gpu = gpu;
    latest.processes = processes || [];
    latest.apps = apps || [];
  } catch (e) {
    console.error('Sampling failed:', e.message);
  }
}

collect();
setInterval(collect, SAMPLE_INTERVAL);

/* ---------------- AI usage: refresh every 10 minutes ---------------- */

const USAGE_INTERVAL = 10 * 60 * 1000;

async function refreshUsage() {
  try {
    latest.usage = await usage.collectUsage({ enabled: activeAIProviders(), enableCustom: CUSTOM_ENABLED });
  } catch (e) {
    console.error('Usage collection failed:', e.message);
  }
}

// Dedupe: manual refresh via /api/usage/refresh shares the in-flight run
let usageRefreshing = null;
function refreshUsageOnce() {
  if (!usageRefreshing) {
    usageRefreshing = refreshUsage().finally(() => {
      usageRefreshing = null;
    });
  }
  return usageRefreshing;
}

refreshUsageOnce();
setInterval(refreshUsageOnce, USAGE_INTERVAL);

/* ---------------- HTTP server ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, data, status = 200) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (CORS) headers['Access-Control-Allow-Origin'] = CORS;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer((req, res) => {
  if (!REMOTE && !httpSecurity.isLoopbackHost(req.headers.host || '')) {
    return sendJson(res, { error: 'invalid host' }, 403);
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/api/stats' || p === '/api/all') return sendJson(res, latest);
  if (p === '/api/cpu') return sendJson(res, latest.cpu);
  if (p === '/api/gpu') return sendJson(res, latest.gpu);
  if (p === '/api/memory') return sendJson(res, latest.memory);
  if (p === '/api/processes') return sendJson(res, latest.processes);
  if (p === '/api/apps') return sendJson(res, latest.apps);
  if (p === '/api/usage') return sendJson(res, latest.usage);
  if (p === '/api/usage/refresh' && req.method === 'POST') {
    if (!httpSecurity.isAllowedOrigin(req.headers.origin, PORT)) {
      return sendJson(res, { error: 'invalid origin' }, 403);
    }
    refreshUsageOnce(); // async — results land in latest.usage within ~20s (Kimi pty is slow)
    return sendJson(res, { ok: true, refreshing: true });
  }
  if (p === '/api/health') return sendJson(res, {
    ok: true,
    pid: process.pid,
    timestamp: Date.now(),
    aiProviders: [...activeAIProviders()],
    customEnabled: CUSTOM_ENABLED,
  });

  // static files (confined to the public directory)
  const abs = httpSecurity.publicFile(PUBLIC_DIR, p);
  if (!abs) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    });
    res.end(data);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    fs.writeSync(process.stderr.fd, `Port ${PORT} is already in use. Stop the other process or choose another port, for example: PORT=8788 npx statusweave\n`);
  } else {
    fs.writeSync(process.stderr.fd, `StatusWeave could not start: ${error.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  const dashboardUrl = `http://127.0.0.1:${PORT}`;
  console.log(`✅ Dashboard:     ${dashboardUrl}`);
  console.log(`📡 API data:      ${dashboardUrl}/api/stats`);
  const initialProviders = activeAIProviders();
  console.log(`🔐 AI providers:  ${initialProviders.size ? [...initialProviders].join(', ') : 'not configured (run statusweave authorize)'}`);
  console.log(`🧩 Custom config: ${CUSTOM_ENABLED ? 'enabled' : 'disabled (set STATUSWEAVE_ENABLE_CUSTOM=1)'}`);
  const invite = feedback.firstRunInvite();
  if (invite) for (const line of invite) console.log(line);
  if (HOST !== '127.0.0.1' && HOST !== '::1' && HOST !== 'localhost') {
    console.log(`⚠️  Bound to ${HOST} — metrics are reachable from other hosts!`);
  }
  if (process.env.STATUSWEAVE_OPEN_DASHBOARD === '1') {
    const opened = await openDashboard(dashboardUrl);
    console.log(opened ? '🖥️  Dashboard opened' : `🖥️  Open manually:   ${dashboardUrl}`);
  }
});
