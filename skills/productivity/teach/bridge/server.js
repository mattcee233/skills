'use strict';
// The teach workspace server: serves lessons from the teaching workspace and
// injects the "ask the teacher" widget shell when it does. Node built-ins only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WIDGET_DIR = path.join(__dirname, 'widget');
const WIDGET_SHELL =
  '<link rel="stylesheet" href="/_teach/widget.css">' +
  '<script src="/_teach/widget.js" defer></script>';

// Folders a lesson links to. Nothing else in the workspace is ever served.
const SERVED_FOLDERS = new Set(['lessons', 'reference', 'assets']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function baseHeaders(extra = {}) {
  return { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...extra };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', ...headers }));
  res.end(body);
}

// Turn a request path into a file below one of the served folders, or null.
function resolveServedFile(workspace, rawPath) {
  if (rawPath.includes('\0') || rawPath.includes('\\')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((s, i) => !(i === 0 && s === ''));
  if (segments.length < 2 || segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  const [folder, ...rest] = segments;
  if (!SERVED_FOLDERS.has(folder)) return null;

  const root = path.join(workspace, folder);
  const candidate = path.join(root, ...rest);
  let realRoot;
  let realFile;
  try {
    realRoot = fs.realpathSync(root);
    realFile = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return null;
  if (!fs.statSync(realFile).isFile()) return null;
  return { file: realFile, folder };
}

function injectWidget(html) {
  const index = html.toLowerCase().lastIndexOf('</body>');
  return index === -1 ? html + WIDGET_SHELL : html.slice(0, index) + WIDGET_SHELL + html.slice(index);
}

function serveFile(res, method, file, folder) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  let content = fs.readFileSync(file);
  if (folder === 'lessons' && type.startsWith('text/html')) {
    content = Buffer.from(injectWidget(content.toString('utf8')), 'utf8');
  }
  res.writeHead(200, baseHeaders({ 'Content-Type': type, 'Content-Length': content.length }));
  res.end(method === 'HEAD' ? undefined : content);
}

function serveWidgetAsset(res, method, name) {
  const file = path.join(WIDGET_DIR, name);
  const type = MIME[path.extname(file)];
  if (!type || !fs.existsSync(file)) return send(res, 404, 'Not found');
  const content = fs.readFileSync(file);
  res.writeHead(200, baseHeaders({ 'Content-Type': type, 'Content-Length': content.length }));
  res.end(method === 'HEAD' ? undefined : content);
  return undefined;
}

// The token travels in a header only: never in a path or query string, so it
// cannot end up in a log, a history entry or a Referer.
function hasToken(req, token) {
  const given = req.headers['x-teach-token'];
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function startServer({ workspace, bind, heartbeatMs = 20000 }) {
  const root = fs.realpathSync(workspace);
  const token = crypto.randomBytes(32).toString('hex');
  const streams = new Set();

  const openStream = (res) => {
    res.writeHead(200, baseHeaders({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' }));
    res.write(': connected\n\n');
    streams.add(res);
    res.on('close', () => streams.delete(res));
  };

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(frame);
  };

  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(': heartbeat\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  const handler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    const rawPath = req.url.split('?')[0];
    if (rawPath === '/events') {
      if (!hasToken(req, token)) return send(res, 401, 'Unauthorised');
      return openStream(res);
    }
    if (rawPath.startsWith('/_teach/')) {
      const name = rawPath.slice('/_teach/'.length);
      if (/^[\w.-]+$/.test(name)) return serveWidgetAsset(res, req.method, name);
      return send(res, 404, 'Not found');
    }
    const served = resolveServedFile(root, rawPath);
    if (!served) return send(res, 404, 'Not found');
    return serveFile(res, req.method, served.file, served.folder);
  };

  const listener = http.createServer(handler);
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: listener.address().port,
    token,
    broadcast,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        listener.close(() => resolve());
        for (const res of streams) res.end();
        listener.closeAllConnections();
      }),
  };
}

module.exports = { startServer };
