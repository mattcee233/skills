'use strict';
// Tests for the Pithagoras adapter: implements check, prime and send against a stub webhook
// server according to the adapter contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeWorkspace, openTab, HOLDER, get } = require('./helpers');
const { makeStubPithagoras } = require('./pithagoras-helpers');
const { startServer } = require('../bridge/server');
const { awaitVerdict } = require('./handshake-helpers');
const { PROFILES, getProfile } = require('../bridge/profiles');

const ADAPTER_PATH = path.join(__dirname, '..', 'bridge', 'adapters', 'pithagoras.js');

const EXPECTED_PERMISSIONS =
  "The agent runs with its process's full permissions and has no approval prompts. Web research is not guaranteed and depends on your Pithagoras configuration.";

function runAdapter(workspace, request, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [ADAPTER_PATH];
    if (options.url) args.push('--url', options.url);
    if (options.secret !== undefined) args.push('--secret', options.secret);
    if (options.timeoutMs) args.push('--timeout', String(options.timeoutMs));
    if (options.ceilingMs) args.push('--ceiling', String(options.ceilingMs));

    const child = spawn(process.execPath, args, {
      cwd: workspace.dir,
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// ---------------------------------------------------------------------------
// Acceptance Criterion 6: Permission text
// ---------------------------------------------------------------------------
test('check returns ok and unnarrowed permissions without browser promise', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = await makeStubPithagoras(t, { secret: 'test-secret' });

  const { code, stdout } = await runAdapter(ws, { op: 'check' }, {
    url: stub.url,
    secret: 'test-secret',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.equal(response.permissions, EXPECTED_PERMISSIONS);
  assert.match(response.permissions, /full permissions/i);
  assert.match(response.permissions, /no approval prompts/i);
  assert.doesNotMatch(response.permissions, /browser for research/i);
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 3: Error mappings and fixed hints
// ---------------------------------------------------------------------------
test('check reports unauthorised with fixed hint when secret is rejected', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = await makeStubPithagoras(t, { secret: 'correct-secret' });

  const { code, stdout, stderr } = await runAdapter(ws, { op: 'check' }, {
    url: stub.url,
    secret: 'wrong-secret',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unauthorised');
  assert.equal(response.error.message, 'Pithagoras credentials were not accepted.');
  assert.equal(response.error.hint, 'Check your Pithagoras webhook secret, then press Retry.');

  assert.doesNotMatch(stdout, /wrong-secret/);
  assert.doesNotMatch(stderr, /wrong-secret/);
});

test('check reports unreachable with fixed hint when endpoint is unreachable', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const deadUrl = 'http://127.0.0.1:59998/';

  const { code, stdout } = await runAdapter(ws, { op: 'check' }, {
    url: deadUrl,
    secret: 'some-secret',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unreachable');
  assert.equal(response.error.message, 'Pithagoras could not be reached.');
  assert.equal(response.error.hint, 'Make sure Pithagoras is running and the webhook URL is reachable, then press Retry.');
});

test('dropped connection at ceiling yields timeout with fixed hint', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = await makeStubPithagoras(t, {
    secret: 'test-secret',
    dropConnection: true,
  });

  const { code, stdout } = await runAdapter(ws, { op: 'send', session: 'sess-1', text: 'Hello' }, {
    url: stub.url,
    secret: 'test-secret',
    ceilingMs: 100,
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'timeout');
  assert.equal(response.error.message, 'Pithagoras took too long to reply.');
  assert.equal(response.error.hint, 'The agent may still be working in the background. Press Try again to retry.');
});

test('HTTP 500 ceiling message yields timeout with fixed hint', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = await makeStubPithagoras(t, {
    secret: 'test-secret',
    status: 500,
    body: { error: 'The agent did not finish within 900s' },
  });

  const { code, stdout } = await runAdapter(ws, { op: 'send', session: 'sess-1', text: 'Slow turn' }, {
    url: stub.url,
    secret: 'test-secret',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'timeout');
  assert.equal(response.error.message, 'Pithagoras took too long to reply.');
  assert.equal(response.error.hint, 'The agent may still be working in the background. Press Try again to retry.');
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 2: Bare stop words wrapped and never raw
// ---------------------------------------------------------------------------
test('a message that is only stop, wait or cancel reaches the stub wrapped and never raw', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = await makeStubPithagoras(t, { secret: 'test-secret' });

  const testCases = [
    { input: 'stop', expectedContains: 'The learner says: "stop"' },
    { input: 'WAIT', expectedContains: 'The learner says: "WAIT"' },
    { input: ' cancel! ', expectedContains: 'The learner says: "cancel!"' },
    { input: 'abort.', expectedContains: 'The learner says: "abort."' },
    { input: 'halt', expectedContains: 'The learner says: "halt"' },
    { input: 'hold on', expectedContains: 'The learner says: "hold on"' },
    { input: 'nevermind', expectedContains: 'The learner says: "nevermind"' },
    {
      input: '[sent from lessons/0001-intro.html]\nstop',
      expectedContains: '[sent from lessons/0001-intro.html]\nThe learner says: "stop"',
    },
  ];

  for (const tc of testCases) {
    stub.clearCalls();
    const { code, stdout } = await runAdapter(ws, {
      op: 'send',
      session: 'sess-stop',
      text: tc.input,
    }, {
      url: stub.url,
      secret: 'test-secret',
    });

    assert.equal(code, 0);
    const response = JSON.parse(stdout.trim());
    assert.equal(response.type, 'result');
    assert.equal(response.ok, true);

    const calls = stub.calls();
    assert.equal(calls.length, 1);
    const receivedMessage = calls[0].body.message;
    // Must never be raw stop word
    assert.notEqual(receivedMessage.trim().toLowerCase(), tc.input.trim().toLowerCase());
    assert.ok(
      receivedMessage.includes(tc.expectedContains),
      `Expected message "${receivedMessage}" to include "${tc.expectedContains}"`
    );
  }

  // Verify non-stop words are passed through without wrapping
  stub.clearCalls();
  await runAdapter(ws, {
    op: 'send',
    session: 'sess-normal',
    text: 'How do loops work in Python?',
  }, {
    url: stub.url,
    secret: 'test-secret',
  });
  const normalCalls = stub.calls();
  assert.equal(normalCalls.length, 1);
  assert.equal(normalCalls[0].body.message, 'How do loops work in Python?');
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 4: HTTP 200 refusal text detection
// ---------------------------------------------------------------------------
test('a refusal returned as an HTTP 200 with refusal text is not treated as a successful reply', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());

  const refusalCases = [
    { refusal: true, description: 'stranger refusal' },
    { stopped: true, description: 'Stopped.' },
    { reply: 'Nothing running.', description: 'Nothing running.' },
  ];

  for (const rc of refusalCases) {
    const stub = await makeStubPithagoras(t, {
      secret: 'test-secret',
      ...rc,
    });

    const { code, stdout } = await runAdapter(ws, {
      op: 'send',
      session: 'sess-refusal',
      text: 'Hello teacher',
    }, {
      url: stub.url,
      secret: 'test-secret',
    });

    assert.equal(code, 0);
    const response = JSON.parse(stdout.trim());
    assert.equal(response.type, 'result');
    assert.equal(response.ok, false, `Expected ${rc.description} not to be treated as successful`);
    assert.ok(['unauthorised', 'failed'].includes(response.error.code));
    assert.ok(response.error.hint);
  }
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 5: Secret protection in all outputs
// ---------------------------------------------------------------------------
test('the secret appears in no log, message, hint or result', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const superSecret = 'SUPER_SECRET_TOKEN_XYZ_999';
  const stub = await makeStubPithagoras(t, {
    secret: superSecret,
    reply: `Here is your reply which echoes ${superSecret} in text`,
  });

  // Test check
  const checkRes = await runAdapter(ws, { op: 'check' }, {
    url: stub.url,
    secret: superSecret,
  });
  assert.doesNotMatch(checkRes.stdout, new RegExp(superSecret));
  assert.doesNotMatch(checkRes.stderr, new RegExp(superSecret));

  // Test send with echo
  const sendRes = await runAdapter(ws, {
    op: 'send',
    session: 'sess-secret',
    text: 'Hello',
  }, {
    url: stub.url,
    secret: superSecret,
  });
  assert.doesNotMatch(sendRes.stdout, new RegExp(superSecret));
  assert.doesNotMatch(sendRes.stderr, new RegExp(superSecret));

  // Test error case
  const errRes = await runAdapter(ws, { op: 'check' }, {
    url: stub.url,
    secret: 'wrong-token-for-test',
  });
  assert.doesNotMatch(errRes.stdout, new RegExp(superSecret));
  assert.doesNotMatch(errRes.stderr, new RegExp(superSecret));
});

// ---------------------------------------------------------------------------
// Prime operation tests
// ---------------------------------------------------------------------------
test('prime generates session id and sends instruction to stub webhook', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-intro.html': '<h1>Intro</h1>',
  });
  t.after(() => ws.cleanup());
  const stub = await makeStubPithagoras(t, {
    secret: 'test-secret',
    reply: 'Ready to teach.',
  });

  const instruction = 'You are the teacher for this workspace. Read only.';
  const { code, stdout } = await runAdapter(ws, {
    op: 'prime',
    lesson: 'lessons/0001-intro.html',
    instruction,
  }, {
    url: stub.url,
    secret: 'test-secret',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.ok(response.session, 'returns session');
  assert.ok(typeof response.session === 'string');

  const calls = stub.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.message, instruction);
  assert.equal(calls[0].body.session, response.session);
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 1: Conformance runner integration
// ---------------------------------------------------------------------------
test('adapter passes the conformance runner against the stub webhook', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-intro.html': '<!doctype html><html><body><h1>Intro</h1></body></html>',
  });
  const stub = await makeStubPithagoras(t, {
    secret: 'test-secret',
    reply: 'Understood and ready.',
  });

  const adapterCmd = [process.execPath, ADAPTER_PATH, '--url', stub.url, '--secret', 'test-secret'];
  const server = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: adapterCmd,
  });
  const page = await openTab(server, HOLDER);
  t.after(async () => {
    page.close();
    await server.close();
    ws.cleanup();
  });

  const state = await awaitVerdict(server);
  assert.equal(state.state, 'interactive');
  assert.equal(state.permissions, EXPECTED_PERMISSIONS);

  // Verify chat send works through the server
  stub.setConfig({ reply: 'Python is a high-level language.' });
  const sendRes = await fetch(`http://127.0.0.1:${server.port}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Teach-Token': server.token,
      'X-Teach-Tab': HOLDER,
    },
    body: JSON.stringify({ id: 'pith-msg-1', lesson: '/lessons/0001-intro.html', text: 'What is Python?' }),
  });
  assert.equal(sendRes.status, 202);

  // Poll for reply
  let reply;
  for (let i = 0; i < 20; i++) {
    const res = await (await get(server, '/reply/pith-msg-1')).json();
    if (res.status === 'done') {
      reply = res;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(reply, 'received reply');
  assert.equal(reply.result.ok, true);
  assert.equal(reply.result.text, 'Python is a high-level language.');
});

test('conformance check transitions to static with fixed hint when secret is wrong', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-intro.html': '<!doctype html><html><body><h1>Intro</h1></body></html>',
  });
  const stub = await makeStubPithagoras(t, {
    secret: 'correct-secret',
  });

  const adapterCmd = [process.execPath, ADAPTER_PATH, '--url', stub.url, '--secret', 'wrong-secret'];
  const server = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: adapterCmd,
  });
  const page = await openTab(server, HOLDER);
  t.after(async () => {
    page.close();
    await server.close();
    ws.cleanup();
  });

  const state = await awaitVerdict(server);
  assert.equal(state.state, 'static');
  assert.equal(state.reason, 'unauthorised');
  assert.equal(state.message, 'Pithagoras credentials were not accepted.');
  assert.equal(state.hint, 'Check your Pithagoras webhook secret, then press Retry.');
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 7: Profile table entry
// ---------------------------------------------------------------------------
test('profile table gains the pithagoras entry (adapter, remote)', () => {
  const profile = getProfile('pithagoras');
  assert.ok(profile, 'profile exists for pithagoras');
  assert.equal(profile.id, 'pithagoras');
  assert.equal(profile.remote, true);

  assert.ok(Array.isArray(profile.adapter), 'adapter is a command array');
  assert.equal(profile.adapter[0], process.execPath);
  assert.equal(path.resolve(profile.adapter[1]), path.resolve(ADAPTER_PATH));
});
