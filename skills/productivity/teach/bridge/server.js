'use strict';
// The teach workspace server: serves lessons from the teaching workspace and
// injects the "ask the teacher" widget shell when it does. Node built-ins only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { createChat, failure } = require('./chat');
const { createHandshake } = require('./handshake');
const { checkSignal, createSignalDrop } = require('./signals');
const { createLease, TAB_ID_PATTERN } = require('./lease');

const WIDGET_DIR = path.join(__dirname, 'widget');
const WIDGET_TAGS =
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

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', ...headers }));
  res.end(body);
}

function sendJson(res, status, body) {
  res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 64 * 1024;

// Read a JSON object from the request body, or answer 400 (not an object) or 413 (too big).
function readJson(req, res, onBody) {
  let raw = '';
  let tooBig = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    if (tooBig) return;
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES && !tooBig) {
      tooBig = true;
      raw = '';
      sendJson(res, 413, failure('failed', 'That message is too long.'));
    }
  });
  req.on('end', () => {
    if (tooBig) return;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, failure('failed', 'That message could not be read.'));
    }
    return onBody(body);
  });
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
  return { file: realFile, folder, relative: segments.join('/') };
}

// The workspace-relative path of a served file if it is a lesson page, otherwise null.
function lessonRelative(served) {
  return served && served.folder === 'lessons' && /\.html?$/i.test(served.relative) ? served.relative : null;
}

function injectWidget(html) {
  const index = html.toLowerCase().lastIndexOf('</body>');
  return index === -1 ? html + WIDGET_TAGS : html.slice(0, index) + WIDGET_TAGS + html.slice(index);
}

function sendFileContent(res, method, type, content) {
  res.writeHead(200, baseHeaders({ 'Content-Type': type, 'Content-Length': content.length }));
  res.end(method === 'HEAD' ? undefined : content);
}

function serveFile(res, method, file, folder) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  let content = fs.readFileSync(file);
  if (folder === 'lessons' && type.startsWith('text/html')) {
    content = Buffer.from(injectWidget(content.toString('utf8')), 'utf8');
  }
  sendFileContent(res, method, type, content);
}

function serveWidgetAsset(res, method, name) {
  const file = path.join(WIDGET_DIR, name);
  const type = MIME[path.extname(file)];
  if (!type || !fs.existsSync(file)) return sendText(res, 404, 'Not found');
  sendFileContent(res, method, type, fs.readFileSync(file));
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

// The tab id a page announces in a header: null when it names none, false when it is malformed.
function tabIdOf(req) {
  const given = req.headers['x-teach-tab'];
  if (given === undefined) return null;
  return typeof given === 'string' && TAB_ID_PATTERN.test(given) ? given : false;
}

function blockList(subnets) {
  const list = new net.BlockList();
  for (const [network, prefix, family] of subnets) list.addSubnet(network, prefix, family);
  return list;
}

const LOOPBACK = blockList([['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']]);

// Private, link-local and shared (Tailscale-style) ranges: what a home network uses.
const LOCAL_NETWORKS = blockList([
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
]);

function familyOf(address) {
  const version = net.isIP(address);
  return version === 6 ? 'ipv6' : version === 4 ? 'ipv4' : null;
}

// The one address to listen on besides loopback. An allow-list, not a list of
// spellings to refuse: "every interface" has many spellings, so anything that is
// not plainly a local network address is refused. The server never listens on all
// interfaces.
function checkNetworkAddress(address) {
  const family = typeof address === 'string' ? familyOf(address) : null;
  if (!family) {
    throw new Error(`Refusing to bind: "${address}" is not a single usable address`);
  }
  if (address === '127.0.0.1' || address === '::1') {
    throw new Error(`Refusing to bind: "${address}" is the loopback address the server already listens on`);
  }
  if (!LOCAL_NETWORKS.check(address, family)) {
    throw new Error(`Refusing to bind: "${address}" is not a private network address`);
  }
  return address;
}

// Headers a browser adds to its own requests and a page's script cannot leave off or forge.
// The launcher is not a browser, so a signal request that carries one came from a web page.
function cameFromBrowser(req) {
  return req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined;
}

function isLoopbackPeer(req) {
  const peer = req.socket.remoteAddress;
  return typeof peer === 'string' && LOOPBACK.check(peer, familyOf(peer) || 'ipv4');
}

function listen(listener, port, host) {
  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, host, () => {
      listener.removeListener('error', reject);
      resolve();
    });
  });
}

// Loopback always; plus one chosen address on the same port for "other devices".
async function listenForBind(handler, bind = { mode: 'loopback' }) {
  const mode = bind.mode || 'loopback';
  if (mode !== 'loopback' && mode !== 'network') throw new Error(`Unknown bind mode "${mode}"`);
  const extra = mode === 'network' ? checkNetworkAddress(bind.address) : null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const listeners = [http.createServer(handler)];
    try {
      await listen(listeners[0], 0, '127.0.0.1');
      const port = listeners[0].address().port;
      if (extra) {
        listeners.push(http.createServer(handler));
        await listen(listeners[1], port, extra);
      }
      return { listeners, port, addresses: [{ address: '127.0.0.1', port }, ...(extra ? [{ address: extra, port }] : [])] };
    } catch (err) {
      await Promise.all(listeners.map((l) => new Promise((r) => l.close(() => r()))));
      // The random port was free on loopback but taken on the other address: try another.
      if (!(extra && err.code === 'EADDRINUSE')) throw err;
    }
  }
  throw new Error('Could not find a port that is free on both addresses');
}

const STATE_DIR = '.teach';
const STATE_FILE = 'server.json';
const SIGNALS_DIR = 'signals';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Does something at this port answer as a teach server with this pid? Guards
// against a recycled pid: an unrelated process is never stopped.
async function answersAsTeachServer(port, pid) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_teach/identity`, { signal: AbortSignal.timeout(1000) });
    const body = await res.json();
    return body.teach === true && body.pid === pid;
  } catch {
    return false;
  }
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

async function stopLeftover(stateFile) {
  const state = readState(stateFile);
  if (!state || state.pid === process.pid || !isAlive(state.pid)) return;
  if (!(await answersAsTeachServer(state.port, state.pid))) return;
  process.kill(state.pid);
  for (let waited = 0; isAlive(state.pid) && waited < 3000; waited += 50) await sleep(50);
  if (isAlive(state.pid)) process.kill(state.pid, 'SIGKILL');
}

// Write the state file the launcher reads: owner-only, in a folder that ignores itself.
function writeState(dir, state) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const file = path.join(dir, STATE_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function startServer({ workspace, bind, heartbeatMs = 20000, adapter = null, session = null, sendTimeoutMs, resultTtlMs, checkTimeoutMs, primeTimeoutMs, signalPollMs = 1000, leaseGraceMs }) {
  const root = fs.realpathSync(workspace);
  const stateDir = path.join(root, STATE_DIR);
  const stateFile = path.join(stateDir, STATE_FILE);
  await stopLeftover(stateFile);
  const token = crypto.randomBytes(32).toString('hex');
  const streams = new Set();
  const running = new Set();
  const lease = createLease({ graceMs: leaseGraceMs });
  const chat = createChat({
    workspace: root,
    running,
    onSetupError: (error) => handshake.markUnavailable(error),
    adapter,
    sendTimeoutMs,
    resultTtlMs,
    resolveLesson(pagePath) {
      const served = resolveServedFile(root, pagePath);
      return lessonRelative(served);
    },
  });
  chat.setSession(session);

  const frameOf = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  const openStream = (res, tab) => {
    res.writeHead(200, baseHeaders({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' }));
    res.write(': connected\n\n');
    // A page that connects late, or a tier 2 page, still learns how the handshake went.
    res.write(frameOf('handshake', handshake.state));
    streams.add(res);
    // A page that names its tab is told whether it holds the lease; one that does not is only watching.
    const leaveLease = tab ? lease.connect(tab, (event, data) => res.write(frameOf(event, data))) : null;
    res.on('close', () => {
      streams.delete(res);
      if (leaveLease) leaveLease();
    });
  };

  const broadcast = (event, data) => {
    const frame = frameOf(event, data);
    for (const res of streams) res.write(frame);
  };

  // A lesson path from the agent is a file path, not a URL: turn it into one the server resolves.
  const resolveSignalLesson = (lessonPath) => {
    if (lessonPath.includes('\0')) return null;
    const urlPath = lessonPath.replace(/^(\.\/|\/)+/, '').split('/').map(encodeURIComponent).join('/');
    const served = resolveServedFile(root, `/${urlPath}`);
    return lessonRelative(served);
  };

  // The one way a signal fires, whichever route it came by.
  const fireSignal = ({ event, data }) => {
    broadcast(event, data);
    return streams.size;
  };

  const handshake = createHandshake({ workspace: root, adapter, session, running, setSession: chat.setSession, broadcast, checkTimeoutMs, primeTimeoutMs });
  handshake.start();

  const signalDrop = createSignalDrop({
    dir: path.join(stateDir, SIGNALS_DIR),
    intervalMs: signalPollMs,
    check: (input) => checkSignal(input, resolveSignalLesson),
    fire: fireSignal,
  });
  signalDrop.start();

  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(': heartbeat\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  const handler = (req, res) => {
    const rawPath = req.url.split('?')[0];
    if (req.method === 'POST' && rawPath === '/send') {
      if (!hasToken(req, token)) return sendText(res, 401, 'Unauthorised');
      if (!lease.isHolder(tabIdOf(req))) {
        return sendJson(res, 409, lease.hasHolder() ? failure('in-use') : failure('in-use', 'AI interaction is not active on this page.'));
      }
      return readJson(req, res, (body) => {
        const outcome = chat.submit(body);
        sendJson(res, outcome.status, outcome.body);
      });
    }
    if (req.method === 'POST' && rawPath === '/signal') {
      // Loopback only, and never from a web page: the page holds the same token for /send.
      if (!isLoopbackPeer(req) || cameFromBrowser(req)) return sendText(res, 403, 'Forbidden');
      if (!hasToken(req, token)) return sendText(res, 401, 'Unauthorised');
      return readJson(req, res, (body) => {
        const outcome = checkSignal(body, resolveSignalLesson);
        if (!outcome.ok) return sendJson(res, 400, outcome);
        return sendJson(res, 200, { ok: true, delivered: fireSignal(outcome) });
      });
    }
    if (req.method === 'POST' && rawPath === '/lease/take') {
      if (!hasToken(req, token)) return sendText(res, 401, 'Unauthorised');
      const tab = tabIdOf(req);
      if (!tab) return sendJson(res, 400, { ok: false, message: 'A tab id is required.' });
      if (!lease.take(tab)) return sendJson(res, 409, { ok: false, message: 'That page is not connected to the server.' });
      return sendJson(res, 200, { ok: true, state: 'interactive' });
    }
    if (req.method === 'POST' && rawPath === '/retry') {
      if (!hasToken(req, token)) return sendText(res, 401, 'Unauthorised');
      handshake.retry();
      return sendJson(res, 202, handshake.state);
    }
    if (req.method === 'POST') return sendText(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    if (rawPath.startsWith('/reply/')) {
      if (!hasToken(req, token)) return sendText(res, 401, 'Unauthorised');
      let id;
      try {
        id = decodeURIComponent(rawPath.slice('/reply/'.length));
      } catch {
        return sendText(res, 404, 'Not found');
      }
      return sendJson(res, 200, chat.lookup(id));
    }
    if (rawPath === '/handshake') {
      if (!hasToken(req, token)) return sendText(res, 401, 'Unauthorised');
      return sendJson(res, 200, handshake.state);
    }
    if (rawPath === '/events') {
      if (!hasToken(req, token)) return sendText(res, 401, 'Unauthorised');
      const tab = tabIdOf(req);
      if (tab === false) return sendText(res, 400, 'Bad tab id');
      return openStream(res, tab);
    }
    if (rawPath === '/_teach/identity') {
      if (!isLoopbackPeer(req)) return sendText(res, 404, 'Not found');
      return sendText(res, 200, JSON.stringify({ teach: true, pid: process.pid }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    if (rawPath.startsWith('/_teach/')) {
      const name = rawPath.slice('/_teach/'.length);
      if (/^[\w.-]+$/.test(name)) return serveWidgetAsset(res, req.method, name);
      return sendText(res, 404, 'Not found');
    }
    const served = resolveServedFile(root, rawPath);
    if (!served) return sendText(res, 404, 'Not found');
    return serveFile(res, req.method, served.file, served.folder);
  };

  const { listeners, port, addresses } = await listenForBind(handler, bind);
  writeState(stateDir, { pid: process.pid, port, token });

  return {
    port,
    addresses,
    token,
    broadcast,
    setSession: chat.setSession,
    async close() {
      if (readState(stateFile)?.pid === process.pid) fs.rmSync(stateFile, { force: true });
      clearInterval(heartbeat);
      signalDrop.stop();
      lease.close();
      handshake.stop();
      const adaptersGone = chat.close();
      for (const res of streams) res.end();
      await Promise.all(
        listeners.map((listener) => {
          const closed = new Promise((resolve) => listener.close(resolve));
          listener.closeAllConnections();
          return closed;
        }),
      );
      await adaptersGone;
    },
  };
}

module.exports = { startServer };
