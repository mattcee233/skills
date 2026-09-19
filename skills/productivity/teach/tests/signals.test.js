'use strict';
// Agent-to-page signals, through the server: the signal route and the signal-file drop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../bridge/server');
const { makeWorkspace, openEvents, post, url } = require('./helpers');
const { SIGNAL_FILES: FILES, BAD_SIGNALS } = require('./signal-helpers');

async function withSignals(t, options = {}) {
  const ws = makeWorkspace(FILES);
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' }, signalPollMs: 25, ...options });
  const page = await openEvents(server, server.token);
  t.after(async () => {
    page.close();
    await server.close();
    ws.cleanup();
  });
  return { ws, server, page };
}

const dropFile = (ws, name, content) => {
  const dir = path.join(ws.dir, '.teach', 'signals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return path.join(dir, name);
};

const eventCount = (page, name) => (page.received.match(new RegExp(`event: ${name}\\n`, 'g')) || []).length;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a next-lesson signal reaches a connected page with the lesson and its title', async (t) => {
  const { server, page } = await withSignals(t);
  const res = await post(server, '/signal', { event: 'next-lesson', lesson: 'lessons/0002-recursion.html', title: 'Recursion' });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, delivered: 1 });
  const received = await page.waitFor(/event: next-lesson\ndata: .*\n/);
  assert.match(received, /data: \{"lesson":"\/lessons\/0002-recursion\.html","title":"Recursion"\}/);
});

test('a reload signal reaches a connected page with just the lesson', async (t) => {
  const { server, page } = await withSignals(t);
  const res = await post(server, '/signal', { event: 'reload', lesson: '/lessons/0001-loops.html', title: 'ignored' });

  assert.equal(res.status, 200);
  const received = await page.waitFor(/event: reload\ndata: .*\n/);
  assert.match(received, /data: \{"lesson":"\/lessons\/0001-loops\.html"\}/);
});

test('a signal request without the token is refused and fires nothing', async (t) => {
  const { server, page } = await withSignals(t);
  const body = { event: 'reload', lesson: 'lessons/0001-loops.html' };

  assert.equal((await post(server, '/signal', body, null)).status, 401);
  assert.equal((await post(server, '/signal', body, 'not-the-token')).status, 401);
  await pause(50);
  assert.equal(eventCount(page, 'reload'), 0);
});

test('the token is refused in the path or query of a signal request', async (t) => {
  const { server, page } = await withSignals(t);
  const body = JSON.stringify({ event: 'reload', lesson: 'lessons/0001-loops.html' });
  for (const target of [`/signal?token=${server.token}`, `/signal/${server.token}`, `/signal?t=${server.token}`]) {
    const res = await fetch(url(server, target), { method: 'POST', body });
    assert.notEqual(res.status, 200, target);
  }
  await pause(50);
  assert.equal(eventCount(page, 'reload'), 0);
});

test('a request that comes from a web page cannot fire a signal, even with the page token', async (t) => {
  // The page holds the same token for /send, and a browser on this machine reaches the server over
  // loopback, so what tells it apart from the launcher is the headers only a browser sends.
  const { server, page } = await withSignals(t);
  const body = JSON.stringify({ event: 'reload', lesson: 'lessons/0001-loops.html' });
  const browserHeaders = [{ Origin: `http://127.0.0.1:${server.port}` }, { Origin: 'http://evil.example' }, { 'Sec-Fetch-Site': 'same-origin' }];
  for (const extra of browserHeaders) {
    const res = await fetch(url(server, '/signal'), {
      method: 'POST',
      headers: { 'X-Teach-Token': server.token, 'Content-Type': 'application/json', ...extra },
      body,
    });
    assert.equal(res.status, 403, JSON.stringify(extra));
  }
  await pause(50);
  assert.equal(eventCount(page, 'reload'), 0);
});

test('a signal request from a non-loopback address is refused, even with the token', async (t) => {
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
  if (!external) return t.skip('no private non-loopback IPv4 address on this machine');
  const ws = makeWorkspace(FILES);
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'network', address: external.address } });
  t.after(async () => {
    await server.close();
    ws.cleanup();
  });
  const page = await openEvents(server, server.token);
  t.after(() => page.close());

  const body = JSON.stringify({ event: 'reload', lesson: 'lessons/0001-loops.html' });
  const headers = { 'X-Teach-Token': server.token, 'Content-Type': 'application/json' };
  const viaNetwork = await fetch(url(server, '/signal', external.address), { method: 'POST', headers, body });
  assert.equal(viaNetwork.status, 403);
  await pause(50);
  assert.equal(eventCount(page, 'reload'), 0);

  const viaLoopback = await fetch(url(server, '/signal'), { method: 'POST', headers, body });
  assert.equal(viaLoopback.status, 200);
  return undefined;
});

test('the signal route refuses every bad signal with a reason and fires nothing', async (t) => {
  const { server, page } = await withSignals(t);
  for (const [name, signal] of Object.entries(BAD_SIGNALS)) {
    const res = await post(server, '/signal', signal);
    assert.equal(res.status, 400, name);
    const body = await res.json();
    assert.equal(body.ok, false, name);
    assert.equal(typeof body.message, 'string', name);
  }
  await pause(50);
  assert.doesNotMatch(page.received, /event: (reload|next-lesson)/);
});

test('the signal route refuses a lesson that is not text', async (t) => {
  const { server } = await withSignals(t);
  assert.equal((await post(server, '/signal', { event: 'reload', lesson: 42 })).status, 400);
});

test('the signal route refuses a body that is not a JSON object', async (t) => {
  const { server } = await withSignals(t);
  const res = await fetch(url(server, '/signal'), { method: 'POST', headers: { 'X-Teach-Token': server.token }, body: 'reload' });
  assert.equal(res.status, 400);
});

test('lease events cannot be fired from the signal route: the server makes those itself', async (t) => {
  const { server } = await withSignals(t);
  for (const event of ['displaced', 'lease-free']) {
    assert.equal((await post(server, '/signal', { event })).status, 400, event);
  }
});

test('a signal with no page connected is accepted and reaches nobody', async (t) => {
  const ws = makeWorkspace(FILES);
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' } });
  t.after(async () => {
    await server.close();
    ws.cleanup();
  });
  const res = await post(server, '/signal', { event: 'reload', lesson: 'lessons/0001-loops.html' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, delivered: 0 });
});

test('a dropped signal file fires the event within two seconds and is removed', async (t) => {
  const ws = makeWorkspace(FILES);
  // The default poll interval, so "about once a second" is what is being tested.
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' } });
  const page = await openEvents(server, server.token);
  t.after(async () => {
    page.close();
    await server.close();
    ws.cleanup();
  });

  const file = dropFile(ws, '0001.json', { event: 'next-lesson', lesson: 'lessons/0002-recursion.html', title: 'Recursion' });
  const started = Date.now();
  const received = await page.waitFor(/event: next-lesson\ndata: .*\n/, 2000);

  assert.ok(Date.now() - started < 2000);
  assert.match(received, /"lesson":"\/lessons\/0002-recursion\.html","title":"Recursion"/);
  for (let waited = 0; fs.existsSync(file) && waited < 500; waited += 25) await pause(25);
  assert.equal(fs.existsSync(file), false);
});

test('signal files are fired in name order and each is removed', async (t) => {
  const { ws, page } = await withSignals(t, { signalPollMs: 1000 });
  dropFile(ws, '0002-b.json', { event: 'reload', lesson: 'lessons/0002-recursion.html' });
  dropFile(ws, '0001-a.json', { event: 'reload', lesson: 'lessons/0001-loops.html' });

  const received = await page.waitFor(/event: reload[\s\S]*\n\n[\s\S]*event: reload[\s\S]*\n\n/, 2500);
  assert.ok(received.indexOf('0001-loops') < received.indexOf('0002-recursion'));
  assert.deepEqual(fs.readdirSync(path.join(ws.dir, '.teach', 'signals')), []);
});

test('the signal file route refuses every bad signal the same way the signal route does', async (t) => {
  const { ws, page } = await withSignals(t);
  const names = [];
  let index = 0;
  for (const signal of Object.values(BAD_SIGNALS)) {
    const name = `bad-${String(index++).padStart(2, '0')}.json`;
    names.push(name);
    dropFile(ws, name, signal);
  }
  dropFile(ws, 'not-json.json', 'this is not json');
  names.push('not-json.json');
  dropFile(ws, 'array.json', '[1, 2]');
  names.push('array.json');

  const dir = path.join(ws.dir, '.teach', 'signals');
  for (let waited = 0; fs.readdirSync(dir).some((n) => n.endsWith('.json')) && waited < 3000; waited += 25) await pause(25);

  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.json')), [], 'no bad file is left to be read again');
  await pause(80);
  assert.doesNotMatch(page.received, /event: (reload|next-lesson)/);
  // A refused file is kept under another name so the agent's mistake can be found.
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.rejected')).length, names.length);
});

test('a signal file that is still being written is not refused as invalid', async (t) => {
  const { ws, page } = await withSignals(t, { signalPollMs: 40 });
  const file = dropFile(ws, 'slow.json', '{"event": "reload", "lesso');
  await pause(70);
  fs.writeFileSync(file, JSON.stringify({ event: 'reload', lesson: 'lessons/0001-loops.html' }));

  await page.waitFor(/event: reload/, 2000);
  assert.equal(fs.existsSync(file), false);
});

test('a signal file that is a link to somewhere else is refused, never followed', async (t) => {
  const { ws, page } = await withSignals(t);
  const outside = path.join(ws.dir, 'MISSION.md');
  const dir = path.join(ws.dir, '.teach', 'signals');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(dir, 'link.json'));
  } catch {
    return t.skip('this machine will not let a test create a symbolic link');
  }
  await pause(200);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'Learn loops.');
  assert.doesNotMatch(page.received, /event: (reload|next-lesson)/);
  return undefined;
});

test('a signal file that is far too large is refused', async (t) => {
  const { ws, page } = await withSignals(t);
  const file = dropFile(ws, 'huge.json', JSON.stringify({ event: 'reload', lesson: 'lessons/0001-loops.html', filler: 'x'.repeat(200 * 1024) }));
  for (let waited = 0; fs.existsSync(file) && waited < 2000; waited += 25) await pause(25);
  assert.equal(fs.existsSync(file), false);
  await pause(50);
  assert.doesNotMatch(page.received, /event: reload/);
});

test('the signals folder need not exist, and the poll stops with the server', async (t) => {
  const ws = makeWorkspace(FILES);
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' }, signalPollMs: 25 });
  t.after(() => ws.cleanup());
  await pause(80);
  await server.close();

  dropFile(ws, 'late.json', { event: 'reload', lesson: 'lessons/0001-loops.html' });
  await pause(100);
  assert.ok(fs.existsSync(path.join(ws.dir, '.teach', 'signals', 'late.json')), 'a stopped server does not consume files');
});

test('a hand-written lesson path may start with a dot-slash or a slash, as the launcher allows', async (t) => {
  const { server } = await withSignals(t);
  for (const lesson of ['./lessons/0001-loops.html', '/lessons/0001-loops.html', 'lessons/0001-loops.html']) {
    assert.equal((await post(server, '/signal', { event: 'reload', lesson })).status, 200, lesson);
  }
});
