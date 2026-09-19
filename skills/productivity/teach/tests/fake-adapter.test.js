'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeWorkspace } = require('./helpers');
const { runFakeAdapter } = require('./fake-adapter-client');

test('the fake adapter answers each operation from its script, one JSON line per call', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const script = {
    check: { type: 'result', ok: true, permissions: 'Reads files.' },
    prime: { type: 'result', ok: true, session: 'sess-1' },
    send: { type: 'result', ok: true, text: 'A reply.' },
  };

  assert.deepEqual((await runFakeAdapter(ws, script, { op: 'check' })).result, script.check);
  assert.deepEqual((await runFakeAdapter(ws, script, { op: 'prime', lesson: 'a.html', instruction: 'x' })).result, script.prime);
  assert.deepEqual((await runFakeAdapter(ws, script, { op: 'send', session: 'sess-1', lesson: 'a.html', text: 'hi' })).result, script.send);
});

test('the fake adapter can be scripted to fail, to be slow, and to change the workspace', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const error = { type: 'result', ok: false, error: { code: 'not-logged-in', message: 'Not logged in.', hint: 'Log in.' } };

  assert.deepEqual((await runFakeAdapter(ws, { check: error }, { op: 'check' })).result, error);

  const slow = await runFakeAdapter(ws, { send: { type: 'result', ok: true, text: 'late' }, delayMs: { send: 120 } }, { op: 'send', text: 'x' });
  assert.ok(slow.elapsedMs >= 100, `expected a delay, took ${slow.elapsedMs}ms`);

  await runFakeAdapter(ws, { prime: { type: 'result', ok: true, session: 's' }, writeFileOnPrime: 'lessons/oops.html' }, { op: 'prime' });
  assert.equal(fs.existsSync(path.join(ws.dir, 'lessons/oops.html')), true);
});

test('the fake adapter runs in the workspace and records exactly what it was sent', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const run = await runFakeAdapter(ws, { send: { type: 'result', ok: true, text: 'ok' } }, { op: 'send', text: '--stop "quoted" \n newline' });

  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(ws.dir));
  assert.deepEqual(run.requests.at(-1), { op: 'send', text: '--stop "quoted" \n newline' });
});
