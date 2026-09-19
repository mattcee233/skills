'use strict';
// The launcher an agent runs (`node .teach/signal.js ...`), against a real server and without one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer } = require('../bridge/server');
const { makeWorkspace, openEvents } = require('./helpers');
const { SIGNAL_FILES, BAD_SIGNALS } = require('./signal-helpers');
const { PASSING, fail, withHandshake, awaitVerdict } = require('./handshake-helpers');

const LAUNCHER_SOURCE = path.join(__dirname, '..', 'bridge', 'signal.js');

// Setup copies the launcher into the workspace; the tests do the same, so it must stand alone.
function installLauncher(ws) {
  const dir = path.join(ws.dir, '.teach');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(LAUNCHER_SOURCE, path.join(dir, 'signal.js'));
  return path.join(dir, 'signal.js');
}

// Run the launcher the way the agent does: from the workspace, with `node`, by relative path.
function launch(ws, ...args) {
  installLauncher(ws);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('.teach', 'signal.js'), ...args], { cwd: ws.dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function withServer(t, options = {}) {
  const ws = makeWorkspace(SIGNAL_FILES);
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' }, signalPollMs: 25, ...options });
  const page = await openEvents(server, server.token);
  t.after(async () => {
    page.close();
    await server.close();
    ws.cleanup();
  });
  return { ws, server, page };
}

const signalsDir = (ws) => path.join(ws.dir, '.teach', 'signals');
const dropped = (ws) => (fs.existsSync(signalsDir(ws)) ? fs.readdirSync(signalsDir(ws)).filter((n) => n.endsWith('.json')) : []);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a valid event reaches connected pages, and the token is never on the command line or in the output', async (t) => {
  const { ws, server, page } = await withServer(t);

  const result = await launch(ws, 'next-lesson', 'lessons/0002-recursion.html', 'Recursion');

  assert.equal(result.code, 0, result.stderr);
  const received = await page.waitFor(/event: next-lesson\ndata: .*\n/);
  assert.match(received, /"lesson":"\/lessons\/0002-recursion\.html","title":"Recursion"/);
  assert.equal((result.stdout + result.stderr).includes(server.token), false);
  assert.deepEqual(dropped(ws), [], 'the server took it, so no file is dropped');
});

test('reload takes just a lesson, and accepts a leading slash, dot-slash or backslashes', async (t) => {
  const { ws, page } = await withServer(t);
  for (const lesson of ['lessons/0001-loops.html', '/lessons/0001-loops.html', './lessons/0001-loops.html', 'lessons\\0001-loops.html']) {
    const result = await launch(ws, 'reload', lesson);
    assert.equal(result.code, 0, `${lesson}: ${result.stderr}`);
  }
  await pause(50);
  assert.equal((page.received.match(/event: reload\n/g) || []).length, 4);
});

test('the token comes from the pid and port file: a wrong one there is refused', async (t) => {
  const { ws, page } = await withServer(t);
  const stateFile = path.join(ws.dir, '.teach', 'server.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, token: 'f'.repeat(64) }));

  const result = await launch(ws, 'reload', 'lessons/0001-loops.html');

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /refused|token/i);
  assert.deepEqual(dropped(ws), [], 'a refusal is not the same as an unreachable server');
  await pause(50);
  assert.doesNotMatch(page.received, /event: reload/);
});

test('every bad signal is refused by the launcher with a reason, and nothing is sent or dropped', async (t) => {
  const { ws, page } = await withServer(t);
  for (const [name, signal] of Object.entries(BAD_SIGNALS)) {
    const args = [signal.event, signal.lesson, signal.title].filter((a) => a !== undefined);
    const result = await launch(ws, ...args);
    assert.notEqual(result.code, 0, name);
    assert.notEqual(result.stderr.trim(), '', name);
  }
  assert.deepEqual(dropped(ws), []);
  await pause(50);
  assert.doesNotMatch(page.received, /event: (reload|next-lesson)/);
});

test('with no server running the launcher drops a signal file, and a server started later fires it', async (t) => {
  const ws = makeWorkspace(SIGNAL_FILES);
  t.after(() => ws.cleanup());

  const result = await launch(ws, 'next-lesson', 'lessons/0002-recursion.html', 'Recursion');

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /file/i, 'says what it did instead');
  const files = dropped(ws);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(signalsDir(ws), files[0]), 'utf8')), {
    event: 'next-lesson',
    lesson: 'lessons/0002-recursion.html',
    title: 'Recursion',
  });

  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' }, signalPollMs: 25 });
  t.after(() => server.close());
  const page = await openEvents(server, server.token);
  t.after(() => page.close());
  // The server may have consumed the file before the page connected; the drop is what is proven.
  for (let waited = 0; dropped(ws).length && waited < 3000; waited += 25) await pause(25);
  assert.deepEqual(dropped(ws), []);
});

test('a page that is already connected hears a dropped file the launcher wrote while the server was unreachable', async (t) => {
  const { ws, server, page } = await withServer(t);
  const stateFile = path.join(ws.dir, '.teach', 'server.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  // Point the launcher at a port nothing listens on, as if the server had just gone away.
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, port: 1 }));

  const result = await launch(ws, 'reload', 'lessons/0001-loops.html');

  assert.equal(result.code, 0, result.stderr);
  await page.waitFor(/event: reload/, 2500);
  assert.ok(server.port > 1);
});

test('a state file left by a server that is gone counts as unreachable, and so does no state file at all', async (t) => {
  const ws = makeWorkspace(SIGNAL_FILES);
  t.after(() => ws.cleanup());
  fs.mkdirSync(path.join(ws.dir, '.teach'), { recursive: true });
  fs.writeFileSync(path.join(ws.dir, '.teach', 'server.json'), '{"pid": 1, "port": 1, "token": "abc"}');
  assert.equal((await launch(ws, 'reload', 'lessons/0001-loops.html')).code, 0);
  assert.equal(dropped(ws).length, 1);

  fs.writeFileSync(path.join(ws.dir, '.teach', 'server.json'), 'not json');
  assert.equal((await launch(ws, 'reload', 'lessons/0002-recursion.html')).code, 0);
  assert.equal(dropped(ws).length, 2);
});

test('the fallback refuses a bad signal instead of dropping it', async (t) => {
  const ws = makeWorkspace(SIGNAL_FILES);
  t.after(() => ws.cleanup());
  for (const [name, signal] of Object.entries(BAD_SIGNALS)) {
    const args = [signal.event, signal.lesson, signal.title].filter((a) => a !== undefined);
    assert.notEqual((await launch(ws, ...args)).code, 0, name);
  }
  assert.deepEqual(dropped(ws), []);
});

test('usage mistakes exit with a message that names the commands', async (t) => {
  const ws = makeWorkspace(SIGNAL_FILES);
  t.after(() => ws.cleanup());
  for (const args of [[], ['reload'], ['next-lesson', 'lessons/0001-loops.html'], ['status', 'extra']]) {
    const result = await launch(ws, ...args);
    assert.notEqual(result.code, 0, args.join(' '));
    assert.match(result.stderr, /next-lesson|reload|status/, args.join(' '));
  }
});

test('the launcher reads the handshake state through `status`, including the reason and hint', async (t) => {
  const { ws, server } = await withHandshake(t, { check: fail('not-logged-in', { hint: 'Run agy login.' }), prime: { type: 'result', ok: true, session: 's' }, send: { type: 'result', ok: true, text: 'x' } });
  await awaitVerdict(server);
  const launcherWs = { dir: ws.dir };

  const result = await launch(launcherWs, 'status');

  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.state, 'static');
  assert.equal(state.reason, 'not-logged-in');
  assert.equal(state.hint, 'Run agy login.');
  assert.equal(result.stdout.includes(server.token), false);
});

test('`retry` re-runs the handshake through the launcher and prints the state at that moment', async (t) => {
  const { ws, server, adapter } = await withHandshake(t, { check: fail('not-logged-in'), prime: { type: 'result', ok: true, session: 's' }, send: { type: 'result', ok: true, text: 'x' } });
  await awaitVerdict(server);
  adapter.setScript(PASSING);

  const result = await launch(ws, 'retry');

  assert.equal(result.code, 0, result.stderr);
  assert.ok(['pending', 'static', 'interactive'].includes(JSON.parse(result.stdout).state));
  const state = await awaitVerdict(server);
  assert.equal(state.state, 'interactive');
  const after = await launch(ws, 'status');
  assert.equal(JSON.parse(after.stdout).state, 'interactive');
});

test('`status` and `retry` cannot fall back to a file: with no server they fail and say why', async (t) => {
  const ws = makeWorkspace(SIGNAL_FILES);
  t.after(() => ws.cleanup());
  for (const command of ['status', 'retry']) {
    const result = await launch(ws, command);
    assert.notEqual(result.code, 0, command);
    assert.match(result.stderr, /not running|unreachable|reach/i, command);
  }
  assert.deepEqual(dropped(ws), []);
});

test('the launcher carries a version comment for setup to compare', () => {
  assert.match(fs.readFileSync(LAUNCHER_SOURCE, 'utf8'), /^\/\/ teach-launcher-version: \d+$/m);
});
