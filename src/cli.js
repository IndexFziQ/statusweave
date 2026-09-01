#!/usr/bin/env node
'use strict';

/** StatusWeave terminal renderer: the same console language, native to a TTY. */
const { spawn } = require('child_process');
const path = require('path');
const tokens = require('../public/statusweave.tokens.json');

const PORT = process.env.PORT || 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const INTERVAL = 2000;

function parseArgs(argv) {
  const out = { ascii: false, once: false, json: false, help: false, color: 'auto' };
  for (const arg of argv) {
    if (arg === '--ascii') out.ascii = true;
    else if (arg === '--once') out.once = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--no-color') out.color = 'never';
    else if (arg.startsWith('--color=')) out.color = arg.slice(8);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!['auto', 'always', 'never'].includes(out.color)) throw new Error('--color must be auto, always, or never');
  return out;
}

function printHelp() {
  process.stdout.write(`StatusWeave CLI — local system and AI usage console

Usage:
  statusweave-cli               Interactive TTY dashboard
  statusweave-cli --once        Print one snapshot and exit
  statusweave-cli --json        Print one machine-readable snapshot and exit

Options:
  --ascii                       Use ASCII-only borders and meters
  --color=auto|always|never     Control ANSI color output
  --no-color                    Alias for --color=never
  --once                        Render once instead of watching
  --json                        Machine-readable JSON; diagnostics use stderr
  -h, --help                    Show this help

NO_COLOR is respected. Non-TTY output is plain text with no control characters.
`);
}

async function ensureServer() {
  try {
    const response = await fetch(`${BASE}/api/health`);
    if (response.ok) return true;
  } catch {}
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    detached: true, stdio: 'ignore', env: { ...process.env, PORT: String(PORT) },
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {}
  }
  return false;
}

const ESC = '\x1b[';
const ANSI = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`,
  cyan: `${ESC}38;5;51m`, violet: `${ESC}38;5;141m`, green: `${ESC}38;5;82m`,
  yellow: `${ESC}38;5;220m`, red: `${ESC}38;5;203m`, gray: `${ESC}38;5;245m`,
};
const TOKEN_COLOR = {
  cyan: tokens.colors.active, violet: tokens.colors.unknown, green: tokens.colors.healthy,
  yellow: tokens.colors.warning, red: tokens.colors.critical, gray: tokens.colors.offline,
};
const stripAnsi = (value) => value.replace(/\x1b\[[0-9;]*m/g, '');

function truecolor(hex) {
  const value = String(hex || '').replace('#', '');
  const rgb = value.length === 6 ? [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16)) : null;
  return rgb && rgb.every(Number.isFinite) ? `${ESC}38;2;${rgb.join(';')}m` : '';
}

function renderer(options) {
  const color = options.color === 'always' || (options.color === 'auto' && process.stdout.isTTY && !('NO_COLOR' in process.env));
  const useTruecolor = color && /^(truecolor|24bit)$/i.test(process.env.COLORTERM || '');
  const paint = (name, value) => color ? `${useTruecolor && TOKEN_COLOR[name] ? truecolor(TOKEN_COLOR[name]) : ANSI[name]}${value}${ANSI.reset}` : value;
  const glyph = options.ascii ? {
    tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', on: '#', off: '.', full: '#', empty: '.', pointer: '>',
  } : {
    tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', on: tokens.characters.lampOn,
    off: tokens.characters.lampOff, full: tokens.characters.barFull, empty: tokens.characters.barEmpty, pointer: '▸',
  };
  const tone = (pct) => pct < tokens.meter.warningAt ? 'green' : pct < tokens.meter.criticalAt ? 'yellow' : 'red';
  const meter = (pct, width = tokens.meter.segments) => {
    const value = Math.max(0, Math.min(100, Number(pct) || 0));
    const filled = Math.round((value / 100) * width);
    return paint(tone(value), glyph.full.repeat(filled)) + paint('gray', glyph.empty.repeat(width - filled));
  };
  const status = (label, kind = 'green', filled = kind === 'green' || kind === 'cyan') => `${paint(kind, filled ? glyph.on : glyph.off)} ${label}`;
  const clip = (value, width) => {
    let visible = 0;
    let result = '';
    for (const token of value.match(/\x1b\[[0-9;]*m|./gu) || []) {
      if (token.startsWith('\x1b[')) { result += token; continue; }
      if (visible >= width) break;
      result += token;
      visible++;
    }
    return color && result !== value ? result + ANSI.reset : result;
  };
  const pad = (value, width) => {
    const clipped = clip(value, width);
    return clipped + ' '.repeat(Math.max(0, width - stripAnsi(clipped).length));
  };
  const frame = (title, rows, width) => {
    const inner = width - 2;
    const label = ` ${title.toUpperCase()} `;
    const top = glyph.tl + glyph.h + paint('cyan', label) + glyph.h.repeat(Math.max(0, inner - label.length - 1)) + glyph.tr;
    return [top, ...rows.map((row) => `${glyph.v}${pad(` ${row}`, inner)}${glyph.v}`), glyph.bl + glyph.h.repeat(inner) + glyph.br];
  };
  return { color, glyph, meter, paint, status, frame };
}

function fmtBytes(value) {
  if (value == null) return 'unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 100 ? 0 : 1)}${units[i]}`;
}

function fmtTokens(value) {
  if (value == null) return 'unavailable';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

function fmtUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function resetLabel(window) {
  if (window.resetAfterSeconds == null) return '';
  const seconds = window.resetAfterSeconds;
  return seconds >= 86400
    ? ` · reset ${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
    : ` · reset ${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function plainSnapshot(state) {
  const lines = [
    'StatusWeave snapshot',
    `host: ${state.host.hostname} (${state.host.platform} ${state.host.arch})`,
    `uptime: ${fmtUptime(state.host.uptime)}`,
    `cpu: ${(state.cpu?.overall ?? 0).toFixed(1)}%`,
    `memory: ${(state.memory?.usedPercent ?? 0).toFixed(1)}% (${fmtBytes(state.memory?.used)} / ${fmtBytes(state.memory?.total)})`,
  ];
  if (state.gpu?.utilization != null) lines.push(`gpu: ${state.gpu.utilization.toFixed(1)}%`);
  if (state.swap) lines.push(`swap: ${state.swap.usedPercent.toFixed(1)}%`);
  if (state.disk) lines.push(`disk: ${state.disk.usedPercent.toFixed(1)}%`);
  for (const provider of state.usage?.providers || []) {
    const prefix = `ai.${String(provider.provider).toLowerCase().replace(/\s+/g, '-')}`;
    if (provider.authorizationState) lines.push(`${prefix}.state: ${provider.authorizationState}`);
    if (!provider.detected) lines.push(`${prefix}: unavailable`);
    else if (provider.error) lines.push(`${prefix}: error (${provider.error})`);
    else if (provider.balance) lines.push(`${prefix}.balance: ${provider.balance.available ?? 'unavailable'}`);
    else {
      if (provider.today?.total != null) lines.push(`${prefix}.today_tokens: ${provider.today.total}`);
      for (const window of provider.plan?.windows || []) lines.push(`${prefix}.${window.key || 'limit'}: ${window.pct}%`);
    }
  }
  return lines.join('\n');
}

function consoleSnapshot(state, options) {
  const ui = renderer(options);
  const width = Math.max(40, Math.min(160, process.stdout.columns || 80));
  const meterWidth = width >= 150 ? 20 : width >= 110 ? 14 : 10;
  const cpu = state.cpu || { overall: 0, perCore: [], cores: 0, model: '' };
  const memory = state.memory || {};
  const lines = [];
  lines.push(...ui.frame('StatusWeave / Local Console', [
    `${ui.status('ONLINE')}  ${state.host.hostname} · ${state.host.platform} ${state.host.arch}`,
    `${ui.paint('gray', 'UPTIME')} ${fmtUptime(state.host.uptime)}  ${ui.paint('gray', 'UPDATED')} ${new Date().toLocaleTimeString('en-US')}`,
  ], width));
  lines.push('');
  lines.push(...ui.frame('System', [
    `CPU     ${ui.meter(cpu.overall, meterWidth)} ${ui.paint(cpu.overall < 50 ? 'green' : cpu.overall < 80 ? 'yellow' : 'red', `${cpu.overall.toFixed(1).padStart(5)}%`)} · ${cpu.cores} cores`,
    `MEMORY  ${ui.meter(memory.usedPercent, meterWidth)} ${(memory.usedPercent ?? 0).toFixed(1).padStart(5)}% · ${fmtBytes(memory.used)}/${fmtBytes(memory.total)}`,
    ...(state.gpu?.utilization != null ? [`GPU     ${ui.meter(state.gpu.utilization, meterWidth)} ${state.gpu.utilization.toFixed(1).padStart(5)}%`] : []),
    ...(state.swap ? [`SWAP    ${ui.meter(state.swap.usedPercent, meterWidth)} ${state.swap.usedPercent.toFixed(1).padStart(5)}%`] : []),
    ...(state.disk ? [`DISK    ${ui.meter(state.disk.usedPercent, meterWidth)} ${state.disk.usedPercent.toFixed(1).padStart(5)}%`] : []),
  ], width));

  const providers = state.usage?.providers || [];
  if (providers.length) {
    const rows = [];
    for (const provider of providers) {
      const name = String(provider.provider).toUpperCase().padEnd(10);
      const authState = provider.authorizationState;
      if (authState === 'NOT_CONFIGURED' || authState === 'CONSENT_REVOKED') {
        rows.push(`${name} ${ui.status('SETUP REQUIRED', 'yellow')} · statusweave authorize ${String(provider.provider).toLowerCase()}`);
      } else if (authState === 'CLI_MISSING') rows.push(`${name} ${ui.status('CLI MISSING', 'yellow')}`);
      else if (authState === 'AUTH_REQUIRED') rows.push(`${name} ${ui.status('CLI LOGIN REQUIRED', 'yellow')} · statusweave authorize ${String(provider.provider).toLowerCase()}`);
      else if (authState === 'INTERACTION_REQUIRED') rows.push(`${name} ${ui.status('SETUP REQUIRED', 'yellow')} · statusweave authorize ${String(provider.provider).toLowerCase()}`);
      else if (!provider.detected) rows.push(`${name} ${ui.status('UNAVAILABLE', 'gray')}`);
      else if (provider.error) rows.push(`${name} ${ui.status('ERROR', 'red')} · ${provider.error}`);
      else if (provider.balance) rows.push(`${name} ${ui.status('CONNECTED', 'green')} · balance ${provider.balance.available ?? 'unavailable'}`);
      else {
        rows.push(`${name} ${ui.status('CONNECTED', 'green')}${provider.today?.total != null ? ` · today ${fmtTokens(provider.today.total)} tokens` : ''}`);
        const windows = provider.plan?.windows || [];
        if (provider.planStale) rows.push(`  ${ui.paint('yellow', 'LIMITS CACHED')} · live refresh failed; showing last successful values`);
        for (const window of windows) {
          rows.push(`  ${String(window.label).slice(0, 13).padEnd(13)} ${ui.meter(window.pct, meterWidth)} ${String(window.pct).padStart(3)}%${resetLabel(window)}`);
        }
        if (!windows.length && authState === 'LIMIT_UNAVAILABLE') {
          rows.push(`  ${ui.paint('gray', 'LIMIT UNAVAILABLE')} · usage totals remain available`);
        }
      }
    }
    lines.push('');
    lines.push(...ui.frame('AI Usage / Supported Sources', rows, width));
  }

  if (state.processes?.length) {
    const processLimit = width <= 80 ? 3 : 6;
    const commandWidth = width >= 120 ? 42 : 26;
    const rows = state.processes.slice(0, processLimit).map((process) => {
      const base = `${String(process.pid).padEnd(7)} ${String(process.command).slice(0, commandWidth).padEnd(commandWidth + 1)} CPU ${process.cpu.toFixed(1).padStart(5)}%`;
      return width <= 80 ? base : `${base}  ${fmtBytes(process.rss).padStart(8)}`;
    });
    lines.push('');
    lines.push(...ui.frame('Top Processes', rows, width));
  }
  lines.push('');
  lines.push(ui.paint('gray', `${ui.glyph.pointer} q quit · r refresh AI usage · ${INTERVAL / 1000}s refresh · http://localhost:${PORT}`));
  return lines.join('\n');
}

async function getSnapshot() {
  const response = await fetch(`${BASE}/api/stats`);
  if (!response.ok) throw new Error(`service returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\nTry --help for usage.\n`); process.exitCode = 2; return; }
  if (options.help) { printHelp(); return; }
  process.stdout.on('error', (error) => { if (error.code === 'EPIPE') process.exit(0); throw error; });

  if (!(await ensureServer())) {
    process.stderr.write('StatusWeave could not start the local monitoring service.\n');
    process.exitCode = 1;
    return;
  }

  const interactive = Boolean(process.stdout.isTTY && !options.once && !options.json);
  if (options.json) {
    const state = await getSnapshot();
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  if (!process.stdout.isTTY && !options.once && options.color !== 'always') {
    process.stdout.write(`${plainSnapshot(await getSnapshot())}\n`);
    return;
  }
  if (options.once || !process.stdout.isTTY) {
    process.stdout.write(`${consoleSnapshot(await getSnapshot(), options)}\n`);
    return;
  }

  let stopped = false;
  const restore = (code = 0) => {
    if (stopped) return;
    stopped = true;
    process.stdout.write(`${ESC}?25h${ANSI.reset}`);
    process.exit(code);
  };
  process.stdout.write(`${ESC}?25l`);
  process.on('SIGINT', () => restore(0));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      const key = data.toString();
      if (key === 'q' || key === '\x03') restore(0);
      if (key === 'r') fetch(`${BASE}/api/usage/refresh`, { method: 'POST' }).catch(() => {});
    });
  }
  const tick = async () => {
    try { process.stdout.write(`${ESC}2J${ESC}H${consoleSnapshot(await getSnapshot(), options)}\n`); }
    catch (error) { process.stdout.write(`${ESC}2J${ESC}H${renderer(options).paint('red', `StatusWeave service unavailable: ${error.message}`)}\n`); }
  };
  await tick();
  process.stdout.on('resize', tick);
  setInterval(tick, INTERVAL);
}

main().catch((error) => {
  process.stderr.write(`StatusWeave CLI failed: ${error.message}\n`);
  process.exitCode = 1;
});
