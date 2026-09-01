'use strict';

const path = require('path');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

function hostname(authority) {
  try {
    return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

function isLoopbackHost(authority) {
  return LOOPBACK.has(hostname(authority));
}

function isAllowedOrigin(origin, port) {
  if (!origin) return true; // CLI/native requests do not send Origin.
  try {
    const url = new URL(origin);
    const originPort = url.port || (url.protocol === 'http:' ? '80' : '443');
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname) && originPort === String(port);
  } catch {
    return false;
  }
}

function publicFile(publicDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const absolute = path.resolve(publicDir, relative);
  const rel = path.relative(publicDir, absolute);
  return rel && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? absolute : null;
}

module.exports = { isLoopbackHost, isAllowedOrigin, publicFile };
