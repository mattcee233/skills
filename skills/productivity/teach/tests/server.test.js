'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer } = require('../bridge/server');
const { makeWorkspace, openEvents, url } = require('./helpers');

const LESSON = '<!doctype html><html><body><h1>Loops</h1></body></html>';

async function withServer(t, files, options = {}) {
  const ws = makeWorkspace(files);
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' }, ...options });
  t.after(async () => {
    await server.close();
    ws.cleanup();
  });
  return { ws, server };
}

test('serves a lesson with the widget shell injected and leaves the file on disk unchanged', async (t) => {
  const { ws, server } = await withServer(t, { 'lessons/0001-loops.html': LESSON });

  const res = await fetch(url(server, '/lessons/0001-loops.html'));
  const body = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(body, /<h1>Loops<\/h1>/);
  assert.match(body, /<script[^>]+src="\/_teach\/widget\.js"/);
  assert.match(body, /<link[^>]+href="\/_teach\/widget\.css"/);
  assert.equal(fs.readFileSync(path.join(ws.dir, 'lessons/0001-loops.html'), 'utf8'), LESSON);
});

test('serves the assets and reference documents a lesson links to, without the widget', async (t) => {
  const { server } = await withServer(t, {
    'assets/style.css': 'body{color:#111}',
    'reference/cheat-sheet.html': '<html><body>ref</body></html>',
  });

  const css = await fetch(url(server, '/assets/style.css'));
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.equal(await css.text(), 'body{color:#111}');

  const ref = await fetch(url(server, '/reference/cheat-sheet.html'));
  assert.equal(ref.status, 200);
  assert.doesNotMatch(await ref.text(), /_teach\/widget/);
});

test('sets the no-store and no-referrer headers on every response, including refusals', async (t) => {
  const { server } = await withServer(t, {});
  const res = await fetch(url(server, '/lessons/missing.html'));
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('refuses paths outside the lessons, reference and assets folders', async (t) => {
  const { server } = await withServer(t, {
    'MISSION.md': 'secret mission',
    'NOTES.md': 'notes',
    'learning-records/0001-x.md': 'record',
    '.teach/config.json': '{}',
    'lessons/0001-loops.html': LESSON,
  });

  const attempts = [
    '/MISSION.md',
    '/NOTES.md',
    '/learning-records/0001-x.md',
    '/.teach/config.json',
    '/lessons/../MISSION.md',
    '/lessons/%2e%2e/MISSION.md',
    '/lessons/..%2fMISSION.md',
    '/lessons/%2e%2e%2f%2e%2e%2fMISSION.md',
    '/lessons/..%5cMISSION.md',
    '/lessons/0001-loops.html%00.md',
    '/assets/../MISSION.md',
  ];
  for (const attempt of attempts) {
    // Raw socket-level path so the client does not normalise it away.
    const status = await rawStatus(server.port, attempt);
    assert.ok(status === 400 || status === 404, `${attempt} answered ${status}`);
  }
});

test('refuses a symlink inside the lessons folder that points outside the workspace', async (t) => {
  const { ws, server } = await withServer(t, { 'MISSION.md': 'secret mission' });
  fs.mkdirSync(path.join(ws.dir, 'lessons'), { recursive: true });
  try {
    fs.symlinkSync(path.join(ws.dir, 'MISSION.md'), path.join(ws.dir, 'lessons', 'leak.html'));
  } catch {
    t.skip('symlinks are not permitted here');
    return;
  }
  const res = await fetch(url(server, '/lessons/leak.html'));
  assert.equal(res.status, 404);
});

function rawStatus(port, requestPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(Number(data.split(' ')[1])));
    socket.on('error', reject);
  });
}


test('refuses the event stream without the session token, with a wrong token, or with the token in the query', async (t) => {
  const { server } = await withServer(t, {});
  assert.match(server.token, /^[0-9a-f]{64}$/);

  assert.equal((await fetch(url(server, '/events'))).status, 401);
  assert.equal((await fetch(url(server, '/events'), { headers: { 'X-Teach-Token': 'nope' } })).status, 401);
  assert.equal((await fetch(url(server, `/events?t=${server.token}`))).status, 401);
  assert.equal((await fetch(url(server, `/events/${server.token}`))).status, 404);
});

test('a client with the token receives typed events on the stream', async (t) => {
  const { server } = await withServer(t, {});
  const events = await openEvents(server, server.token);
  t.after(() => events.close());

  assert.equal(events.response.status, 200);
  assert.match(events.response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(events.response.headers.get('cache-control'), 'no-store');

  server.broadcast('test', { hello: 'world' });
  const received = await events.waitFor(/event: test\ndata: \{"hello":"world"\}\n\n/);
  assert.ok(received.includes('event: test'));
});

test('the stream carries a heartbeat comment on schedule', async (t) => {
  const { server } = await withServer(t, {}, { heartbeatMs: 30 });
  const events = await openEvents(server, server.token);
  t.after(() => events.close());
  await events.waitFor(/^: heartbeat$/m);
});

test('stopping the server ends open streams instead of hanging', async () => {
  const ws = makeWorkspace({});
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' } });
  const events = await openEvents(server, server.token);
  await server.close();
  ws.cleanup();
  events.close();
});


function reachable(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host, timeout: 500 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

test('"this computer only" listens on the loopback address and nothing else', async (t) => {
  const { server } = await withServer(t, {});
  assert.deepEqual(server.addresses, [{ address: '127.0.0.1', port: server.port }]);

  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i.family === 'IPv4' && !i.internal);
  if (!external) return t.skip('no non-loopback IPv4 address on this machine');
  assert.equal(await reachable(server.port, external.address), false);
  return undefined;
});

test('"other devices" listens on loopback plus the chosen address, on one shared port', async (t) => {
  // 127.0.0.2 stands in for a private LAN address so the test needs no network.
  const { server } = await withServer(t, { 'lessons/0001-x.html': LESSON }, {
    bind: { mode: 'network', address: '127.0.0.2' },
  });
  assert.deepEqual(server.addresses, [
    { address: '127.0.0.1', port: server.port },
    { address: '127.0.0.2', port: server.port },
  ]);
  for (const host of ['127.0.0.1', '127.0.0.2']) {
    const res = await fetch(url(server, '/lessons/0001-x.html', host));
    assert.equal(res.status, 200, host);
  }

  const viaLan = await openEvents(server, server.token, '127.0.0.2');
  t.after(() => viaLan.close());
  server.broadcast('test', { on: 'both' });
  await viaLan.waitFor(/event: test/);
});

test('refuses to bind every interface, whichever way it is spelled', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const everyInterface = [
    '0.0.0.0', '::', '::0', '0', '', undefined, '0.0.0.0/0',
    // other spellings of the IPv6 unspecified address, and its IPv4-mapped forms
    '0::0', '::0:0', '0:0::', '00::', '0000:0000:0000:0000:0000:0000:0000:0000', '::ffff:0:0', '::ffff:0.0.0.0',
    // the rest of 0.0.0.0/8, and broadcast
    '0.0.0.1', '255.255.255.255',
  ];
  for (const address of everyInterface) {
    await assert.rejects(
      startServer({ workspace: ws.dir, bind: { mode: 'network', address } }),
      /Refusing to bind/,
      `address ${JSON.stringify(address)} should be refused`,
    );
  }
});


const stateFile = (ws) => path.join(ws.dir, '.teach', 'server.json');
const readState = (ws) => JSON.parse(fs.readFileSync(stateFile(ws), 'utf8'));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}

test('records its pid, port and token in a self-ignoring state folder, and removes them on a clean stop', async (t) => {
  const ws = makeWorkspace({});
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' } });
  t.after(() => ws.cleanup());

  assert.deepEqual(readState(ws), { pid: process.pid, port: server.port, token: server.token });
  assert.equal(fs.readFileSync(path.join(ws.dir, '.teach', '.gitignore'), 'utf8').trim(), '*');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(stateFile(ws)).mode & 0o777, 0o600);
  }

  await server.close();
  assert.equal(fs.existsSync(stateFile(ws)), false);
});

test('starting a server stops a leftover server found through the state file', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const leftover = spawn(process.execPath, [path.join(__dirname, 'leftover-server.js'), ws.dir], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => leftover.kill());
  await new Promise((resolve) => leftover.stdout.once('data', resolve));
  assert.equal(readState(ws).pid, leftover.pid);

  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' } });
  t.after(() => server.close());

  await until(() => !alive(leftover.pid));
  assert.equal(readState(ws).pid, process.pid);
});

test('a stale state file, or one naming an unrelated process, is overwritten and the process left alone', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => bystander.kill());
  fs.mkdirSync(path.join(ws.dir, '.teach'));

  for (const stale of [{ pid: 2 ** 22 + 12345, port: 1, token: 'x' }, { pid: bystander.pid, port: 1, token: 'x' }]) {
    fs.writeFileSync(stateFile(ws), JSON.stringify(stale));
    const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' } });
    assert.equal(readState(ws).pid, process.pid);
    await server.close();
  }
  assert.equal(alive(bystander.pid), true, 'an unrelated process must never be stopped');
});

test('serves the widget script and stylesheet, and nothing else from the server folder', async (t) => {
  const { server } = await withServer(t, {});

  const script = await fetch(url(server, '/_teach/widget.js'));
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
  assert.equal(script.headers.get('cache-control'), 'no-store');
  const style = await fetch(url(server, '/_teach/widget.css'));
  assert.equal(style.status, 200);
  assert.match(style.headers.get('content-type'), /^text\/css/);

  for (const attempt of ['/_teach/server.js', '/_teach/serve.js', '/_teach/..', '/_teach/../server.js', '/_teach/..%2fserver.js', '/_teach/%2e%2e%2fserver.js']) {
    const status = await rawStatus(server.port, attempt);
    assert.ok(status === 400 || status === 404, `${attempt} answered ${status}`);
  }
});

test('refuses a public address, and the loopback address it already listens on', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '127.0.0.1']) {
    await assert.rejects(
      startServer({ workspace: ws.dir, bind: { mode: 'network', address } }),
      /Refusing to bind/,
      `address ${address} should be refused`,
    );
  }
});

test('the identity endpoint used to find a leftover server answers loopback callers only', async (t) => {
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
  if (!external) return t.skip('no private non-loopback IPv4 address on this machine');
  const { server } = await withServer(t, {}, { bind: { mode: 'network', address: external.address } });

  const viaLoopback = await fetch(url(server, '/_teach/identity'));
  assert.equal(viaLoopback.status, 200);
  const viaNetwork = await fetch(url(server, '/_teach/identity', external.address));
  assert.equal(viaNetwork.status, 404);
  return undefined;
});
