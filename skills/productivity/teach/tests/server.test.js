'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../bridge/server');
const { makeWorkspace, url } = require('./helpers');

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
  const net = require('node:net');
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

const { openEvents } = require('./helpers');

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
