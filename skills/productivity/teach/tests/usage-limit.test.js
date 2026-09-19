'use strict';
// A used-up usage allowance is a failure the learner can only wait out. Each adapter recognises
// it from the engine's own words and answers with a fixed, specific message and hint (never the
// engine's text), on the existing `failed` code, so the page shows it through the normal error
// path: the handshake's not-connected state at start, and the chat error mid-session.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeWorkspace, openTab, HOLDER } = require('./helpers');
const { makeStubClaude } = require('./claude-helpers');
const { makeStubAgy } = require('./agy-helpers');
const { makeStubPi } = require('./pi-helpers');
const { startServer } = require('../bridge/server');

const ADAPTERS = path.join(__dirname, '..', 'bridge', 'adapters');
const SECRET = 'account acc_secret_999';

function runAdapter(file, workspace, cliString, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ADAPTERS, file), '--cli', cliString], { cwd: workspace.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', () => resolve(JSON.parse(stdout.trim())));
    child.stdin.end(JSON.stringify(request));
  });
}

function assertUsageLimit(response, engine) {
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'failed');
  assert.match(response.error.message, new RegExp(`${engine}.*usage limit`, 'i'));
  assert.match(response.error.hint, /wait/i);
  assert.match(response.error.hint, /Try again/);
  assert.doesNotMatch(JSON.stringify(response), /acc_secret/, "the engine's own text is never passed on");
}

const CASES = [
  {
    engine: 'Claude Code',
    adapter: 'claude-code.js',
    make: makeStubClaude,
    turn: { exitCode: 1, output: `Claude AI usage limit reached|1789000000 ${SECRET}` },
  },
  {
    engine: 'Antigravity',
    adapter: 'agy.js',
    make: makeStubAgy,
    turn: { exitCode: 1, stderr: `Error: RESOURCE_EXHAUSTED: quota exceeded for this account. ${SECRET}` },
  },
  {
    engine: 'pi',
    named: 'The model provider',
    adapter: 'pi.js',
    make: makeStubPi,
    turn: { stopReason: 'error', errorMessage: `429 Too Many Requests: rate limit exceeded ${SECRET}`, text: '' },
  },
];

for (const { engine, named = engine, adapter, make, turn } of CASES) {
  test(`${engine}: a used-up allowance on the priming turn is reported as a usage limit`, async (t) => {
    const ws = makeWorkspace({});
    t.after(() => ws.cleanup());
    const stub = make(t, { prime: turn });
    assertUsageLimit(await runAdapter(adapter, ws, stub.cliString, { op: 'prime', instruction: 'Read only.' }), named);
  });

  test(`${engine}: a used-up allowance mid-session is reported as a usage limit`, async (t) => {
    const ws = makeWorkspace({});
    t.after(() => ws.cleanup());
    const stub = make(t, { send: turn });
    assertUsageLimit(await runAdapter(adapter, ws, stub.cliString, { op: 'send', session: 's1', text: 'hi' }), named);
  });
}

test('Antigravity: a usage limit reported in the JSON status is recognised too', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubAgy(t, { prime: { rawOutput: JSON.stringify({ status: 'ERROR', error: `usage limit reached ${SECRET}` }) } });
  assertUsageLimit(await runAdapter('agy.js', ws, stub.cliString, { op: 'prime', instruction: 'Read only.' }), 'Antigravity');
});

test('an ordinary failure is still just failed, not a usage limit', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubAgy(t, { send: { exitCode: 1, stderr: 'segfault in renderer' } });
  const response = await runAdapter('agy.js', ws, stub.cliString, { op: 'send', session: 's1', text: 'hi' });
  assert.equal(response.error.code, 'failed');
  assert.doesNotMatch(response.error.message, /usage limit/i);
});

test('at start the page gets the usage-limit message and hint in the not-connected state', async (t) => {
  const ws = makeWorkspace({});
  const stub = makeStubAgy(t, { prime: { exitCode: 1, stderr: `RESOURCE_EXHAUSTED: quota exceeded ${SECRET}` } });
  const server = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: [process.execPath, path.join(ADAPTERS, 'agy.js'), '--cli', stub.cliString],
  });
  const page = await openTab(server, HOLDER);
  t.after(async () => {
    page.close();
    await server.close();
    ws.cleanup();
  });

  let state;
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`http://127.0.0.1:${server.port}/handshake`, { headers: { 'X-Teach-Token': server.token } });
    state = await res.json();
    if (state.state !== 'pending') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state.state, 'static');
  assert.equal(state.reason, 'failed');
  assert.match(state.message, /usage limit/i);
  assert.match(state.hint, /Try again|Retry/);
  assert.doesNotMatch(JSON.stringify(state), /acc_secret/);
});
