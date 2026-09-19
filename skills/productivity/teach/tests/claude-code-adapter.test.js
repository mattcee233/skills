'use strict';
// Tests for the Claude Code adapter: implements check, prime and send against a stub `claude`
// executable according to the adapter contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeWorkspace } = require('./helpers');
const { makeStubClaude } = require('./claude-helpers');

const ADAPTER_PATH = path.join(__dirname, '..', 'bridge', 'adapters', 'claude-code.js');

const EXPECTED_PERMISSIONS =
  'File reading and editing in the workspace, browser for research, and terminal limited to the signalling command.';

function runAdapter(workspace, cliString, request) {
  return new Promise((resolve, reject) => {
    const args = [ADAPTER_PATH, '--cli', cliString];
    const child = spawn(process.execPath, args, {
      cwd: workspace.dir,
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

test('check returns ok and the narrow permission grant when logged in', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubClaude(t, {
    authStatus: { exitCode: 0 },
  });

  const { code, stdout } = await runAdapter(ws, stub.cliString, { op: 'check' });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.equal(response.permissions, EXPECTED_PERMISSIONS);
});

test('check reports not-logged-in with fixed hint and redacts auth output', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const sensitiveOutput = JSON.stringify({ email: 'learner@secret.corp', account_id: 'acc_secret_999' });
  const stub = makeStubClaude(t, {
    authStatus: { exitCode: 1, output: sensitiveOutput },
  });

  const { code, stdout, stderr } = await runAdapter(ws, stub.cliString, { op: 'check' });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'not-logged-in');
  assert.equal(response.error.message, 'Claude Code is not logged in.');
  assert.equal(response.error.hint, 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.');

  // Verify that sensitive auth status output is nowhere in stdout or stderr
  assert.doesNotMatch(stdout, /learner@secret\.corp/);
  assert.doesNotMatch(stdout, /acc_secret_999/);
  assert.doesNotMatch(stderr, /learner@secret\.corp/);
  assert.doesNotMatch(stderr, /acc_secret_999/);
});

test('check reports missing when the CLI executable cannot be found', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const nonExistentCli = JSON.stringify([path.join(ws.dir, 'does-not-exist', 'claude.exe')]);

  const { code, stdout } = await runAdapter(ws, nonExistentCli, { op: 'check' });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'missing');
  assert.equal(response.error.message, 'Claude Code is not installed.');
  assert.equal(response.error.hint, 'Install Claude Code and make sure it is on your PATH, then press Retry.');
});

test('prime generates session id, runs from workspace with narrow grant, and passes instruction as one arg', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-loops.html': '<h1>Loops</h1>',
  });
  t.after(() => ws.cleanup());
  const stub = makeStubClaude(t, {
    prime: { result: 'Acknowledged.' },
  });

  const instruction = 'You are the teacher for this workspace. Read only. Do not change anything.';
  const { code, stdout } = await runAdapter(ws, stub.cliString, {
    op: 'prime',
    lesson: 'lessons/0001-loops.html',
    instruction,
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.match(response.session, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  // Verify how stub was invoked
  const calls = stub.calls();
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.cwd, ws.dir);

  // Narrow grant applied
  assert.ok(call.argv.includes('-p'), 'runs in print mode');
  assert.ok(call.argv.includes('--session-id'), 'passes session-id');
  const sessionIdx = call.argv.indexOf('--session-id');
  assert.equal(call.argv[sessionIdx + 1], response.session);

  assert.ok(call.argv.includes('--permission-mode'), 'specifies permission-mode');
  const permIdx = call.argv.indexOf('--permission-mode');
  assert.equal(call.argv[permIdx + 1], 'acceptEdits');

  const toolsIdx = call.argv.findIndex((a) => a === '--allowedTools' || a === '--allowed-tools');
  assert.ok(toolsIdx !== -1, 'passes allowed tools');
  assert.ok(call.argv[toolsIdx + 1].includes('Bash(node .teach/signal.js *)'), 'terminal limited to signalling');
  assert.ok(call.argv[toolsIdx + 1].includes('WebFetch'), 'allows browser research');

  assert.ok(!call.argv.includes('--dangerously-skip-permissions'), 'never skips permission prompts');
  assert.ok(!call.argv.includes('--allow-dangerously-skip-permissions'), 'never skips permission prompts');

  // Instruction passed as single argument
  assert.ok(call.argv.includes(instruction), 'instruction is passed as one argument');
});

test('send resumes session, runs from workspace with narrow grant, and passes text as one arg', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-loops.html': '<h1>Loops</h1>',
  });
  t.after(() => ws.cleanup());
  const stub = makeStubClaude(t, {
    send: { result: 'A loop in Python repeats code.' },
  });

  const session = '7b9195b0-3944-49af-90a3-eeec6e4b3d18';
  const text = '[sent from lessons/0001-loops.html]\nCan you explain "for" loops in Python?';
  const { code, stdout } = await runAdapter(ws, stub.cliString, {
    op: 'send',
    session,
    lesson: 'lessons/0001-loops.html',
    text,
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.equal(response.text, 'A loop in Python repeats code.');

  // Verify how stub was invoked
  const calls = stub.calls();
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.cwd, ws.dir);

  assert.ok(call.argv.includes('-p'), 'runs in print mode');
  assert.ok(call.argv.includes('--resume'), 'resumes session');
  const resumeIdx = call.argv.indexOf('--resume');
  assert.equal(call.argv[resumeIdx + 1], session);

  assert.ok(call.argv.includes('--permission-mode'), 'specifies permission-mode');
  const permIdx = call.argv.indexOf('--permission-mode');
  assert.equal(call.argv[permIdx + 1], 'acceptEdits');

  const toolsIdx = call.argv.findIndex((a) => a === '--allowedTools' || a === '--allowed-tools');
  assert.ok(toolsIdx !== -1, 'passes allowed tools');
  assert.ok(call.argv[toolsIdx + 1].includes('Bash(node .teach/signal.js *)'), 'terminal limited to signalling');
  assert.ok(call.argv[toolsIdx + 1].includes('WebFetch'), 'allows browser research');

  assert.ok(!call.argv.includes('--dangerously-skip-permissions'), 'never skips permission prompts');
  assert.ok(!call.argv.includes('--allow-dangerously-skip-permissions'), 'never skips permission prompts');

  // Text passed as single argument
  assert.ok(call.argv.includes(text), 'learner text is passed as one argument');
});

test('prime and send map unauthorised failure with fixed hint and safe message', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubClaude(t, {
    prime: { exitCode: 1, stderr: '401 Unauthorized: Invalid API key' },
    send: { exitCode: 1, stderr: '401 Unauthorized: Invalid API key' },
  });

  const primeRes = await runAdapter(ws, stub.cliString, { op: 'prime', instruction: 'read' });
  const parsedPrime = JSON.parse(primeRes.stdout.trim());
  assert.equal(parsedPrime.type, 'result');
  assert.equal(parsedPrime.ok, false);
  assert.equal(parsedPrime.error.code, 'unauthorised');
  assert.equal(parsedPrime.error.message, 'Claude Code credentials were not accepted.');
  assert.equal(parsedPrime.error.hint, 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.');

  const sendRes = await runAdapter(ws, stub.cliString, { op: 'send', session: 's1', text: 'hi' });
  const parsedSend = JSON.parse(sendRes.stdout.trim());
  assert.equal(parsedSend.type, 'result');
  assert.equal(parsedSend.ok, false);
  assert.equal(parsedSend.error.code, 'unauthorised');
  assert.equal(parsedSend.error.message, 'Claude Code credentials were not accepted.');
  assert.equal(parsedSend.error.hint, 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.');
});

test('prime and send map unreachable failure with fixed hint and safe message', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubClaude(t, {
    send: { exitCode: 1, stderr: 'TypeError: fetch failed (ECONNREFUSED)' },
  });

  const sendRes = await runAdapter(ws, stub.cliString, { op: 'send', session: 's1', text: 'hi' });
  const parsedSend = JSON.parse(sendRes.stdout.trim());
  assert.equal(parsedSend.type, 'result');
  assert.equal(parsedSend.ok, false);
  assert.equal(parsedSend.error.code, 'unreachable');
  assert.equal(parsedSend.error.message, 'Claude Code could not reach the server.');
  assert.equal(parsedSend.error.hint, 'Check your internet connection and try again.');
});

test('send maps not-logged-in mid-session failure with fixed hint and safe message', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubClaude(t, {
    send: { exitCode: 1, stderr: 'Authentication required. Please log in.' },
  });

  const sendRes = await runAdapter(ws, stub.cliString, { op: 'send', session: 's1', text: 'hi' });
  const parsedSend = JSON.parse(sendRes.stdout.trim());
  assert.equal(parsedSend.type, 'result');
  assert.equal(parsedSend.ok, false);
  assert.equal(parsedSend.error.code, 'not-logged-in');
  assert.equal(parsedSend.error.message, 'Claude Code is not logged in.');
  assert.equal(parsedSend.error.hint, 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.');
});

test('send maps generic failure with fixed hint and safe message', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubClaude(t, {
    send: { exitCode: 2, stderr: 'Internal crash in engine' },
  });

  const sendRes = await runAdapter(ws, stub.cliString, { op: 'send', session: 's1', text: 'hi' });
  const parsedSend = JSON.parse(sendRes.stdout.trim());
  assert.equal(parsedSend.type, 'result');
  assert.equal(parsedSend.ok, false);
  assert.equal(parsedSend.error.code, 'failed');
  assert.equal(parsedSend.error.message, 'Claude Code could not complete the request.');
  assert.equal(parsedSend.error.hint, 'Check Claude Code output, or press Try again.');
});

test('adapter maps timeout with fixed hint and safe message', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubClaude(t, {
    send: { delayMs: 1000 },
  });

  const sendRes = await new Promise((resolve, reject) => {
    const args = [ADAPTER_PATH, '--cli', stub.cliString, '--timeout', '50'];
    const child = spawn(process.execPath, args, { cwd: ws.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify({ op: 'send', session: 's1', text: 'hi' }));
  });

  assert.equal(sendRes.code, 0);
  const parsed = JSON.parse(sendRes.stdout.trim());
  assert.equal(parsed.type, 'result');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'timeout');
  assert.equal(parsed.error.message, 'Claude Code took too long to reply.');
  assert.equal(parsed.error.hint, 'Press Try again to retry the request.');
});

test('adapter passes the conformance runner end-to-end against stub claude', async (t) => {
  const { startServer } = require('../bridge/server');
  const { awaitVerdict } = require('./handshake-helpers');
  const { get, openTab, HOLDER } = require('./helpers');

  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>',
  });
  const stub = makeStubClaude(t, {
    authStatus: { exitCode: 0 },
    prime: { result: 'Acknowledged.' },
    send: { result: 'Loops repeat code.' },
  });

  const adapterCmd = [process.execPath, ADAPTER_PATH, '--cli', stub.cliString];
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

  // Send a message through the server and verify chat round trip
  const sendRes = await fetch(`http://127.0.0.1:${server.port}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Teach-Token': server.token,
      'X-Teach-Tab': HOLDER,
    },
    body: JSON.stringify({ id: 'msg-1', lesson: '/lessons/0001-loops.html', text: 'Hello' }),
  });
  assert.equal(sendRes.status, 202);

  // Poll for reply
  let reply;
  for (let i = 0; i < 20; i++) {
    const res = await (await get(server, '/reply/msg-1')).json();
    if (res.status === 'done') {
      reply = res;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(reply, 'received reply');
  assert.equal(reply.result.ok, true);
  assert.equal(reply.result.text, 'Loops repeat code.');
});

test('conformance check transitions to static with fixed hint when claude is not logged in', async (t) => {
  const { startServer } = require('../bridge/server');
  const { awaitVerdict } = require('./handshake-helpers');
  const { openTab, HOLDER } = require('./helpers');

  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>',
  });
  const stub = makeStubClaude(t, {
    authStatus: { exitCode: 1, output: '{"email":"leak@secret.com"}' },
  });

  const adapterCmd = [process.execPath, ADAPTER_PATH, '--cli', stub.cliString];
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
  assert.equal(state.reason, 'not-logged-in');
  assert.equal(state.message, 'Claude Code is not logged in.');
  assert.equal(state.hint, 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.');

  // Verify prime was not invoked
  const primeCalls = stub.calls().filter((c) => c.argv.includes('--session-id'));
  assert.equal(primeCalls.length, 0, 'prime must not run when check fails');
});

test('profile table contains claude-code entry pointing at this adapter', () => {
  const { PROFILES, getProfile } = require('../bridge/profiles');

  const profile = getProfile('claude-code');
  assert.ok(profile, 'profile exists for claude-code');
  assert.equal(profile.id, 'claude-code');
  assert.equal(profile.remote, false);
  assert.equal(profile.cli, 'claude');
  assert.ok(profile.installHint);
  assert.ok(profile.loginHint);

  assert.ok(Array.isArray(profile.adapter), 'adapter is a command array');
  assert.equal(profile.adapter[0], process.execPath);
  assert.equal(path.resolve(profile.adapter[1]), path.resolve(ADAPTER_PATH));
});







