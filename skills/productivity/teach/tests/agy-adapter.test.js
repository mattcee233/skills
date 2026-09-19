'use strict';
// Tests for the Antigravity (`agy`) adapter: implements check, prime and send against a stub `agy`
// executable according to the adapter contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { makeWorkspace } = require('./helpers');
const { makeStubAgy } = require('./agy-helpers');
const { getProfile } = require('../bridge/profiles');

const ADAPTER_PATH = path.join(__dirname, '..', 'bridge', 'adapters', 'agy.js');

const PERMISSIONS_FILE_DROP =
  'File reading and editing in the workspace, browser for research, and no terminal access (signalling via file drop).';

const PERMISSIONS_NARROW_TERMINAL =
  'File reading and editing in the workspace, browser for research, and terminal limited to the signalling command.';

function runAdapter(workspace, cliString, request, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [ADAPTER_PATH, '--cli', cliString, ...extraArgs];
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

test('check returns ok and falls back to file drop permission grant by default', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubAgy(t, {
    version: { exitCode: 0, output: '1.2.7\n' },
  });

  // Supply non-existent settings path so it falls back to file drop
  const dummySettings = path.join(ws.dir, 'no-settings.json');
  const { code, stdout } = await runAdapter(ws, stub.cliString, { op: 'check' }, [
    '--settings-path', dummySettings,
  ]);

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.equal(response.permissions, PERMISSIONS_FILE_DROP);
});

test('check returns narrow terminal grant when settings.json has matching signalling command rule', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubAgy(t, {
    version: { exitCode: 0, output: '1.2.7\n' },
  });

  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-settings-'));
  t.after(() => fs.rmSync(settingsDir, { recursive: true, force: true }));
  const settingsPath = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      permissions: {
        allow: ['command(regex:node\\s+.*signal\\.js.*)'],
      },
    })
  );

  const { code, stdout } = await runAdapter(ws, stub.cliString, { op: 'check' }, [
    '--settings-path', settingsPath,
  ]);

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.equal(response.permissions, PERMISSIONS_NARROW_TERMINAL);
});

test('check reports missing when the agy executable cannot be found', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const nonExistentCli = JSON.stringify([path.join(ws.dir, 'does-not-exist', 'agy.exe')]);

  const { code, stdout } = await runAdapter(ws, nonExistentCli, { op: 'check' });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'missing');
  assert.equal(response.error.message, 'Antigravity CLI (agy) is not installed.');
  assert.equal(
    response.error.hint,
    'Install the Antigravity CLI (agy) and restart your application, or check the known install folder (%LOCALAPPDATA%\\agy\\bin or ~/.local/bin), then press Retry.'
  );
});

test('prime runs from workspace with extra-folder argument and returns conversation_id as session', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-loops.html': '<h1>Loops</h1>',
  });
  t.after(() => ws.cleanup());
  const stub = makeStubAgy(t, {
    prime: {
      result: 'Acknowledged lesson context.',
    },
  });

  const { code, stdout } = await runAdapter(ws, stub.cliString, {
    op: 'prime',
    lesson: 'lessons/0001-loops.html',
    instruction: 'Read MISSION.md and acknowledge.',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.equal(response.session, 'stub-conv-agy-123');

  // Verify CLI calls: cwd is workspace, arguments include --add-dir .
  const calls = stub.calls();
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(path.resolve(call.cwd), path.resolve(ws.dir));
  assert.ok(call.argv.includes('--add-dir'), 'call includes --add-dir argument');
  const addDirIdx = call.argv.indexOf('--add-dir');
  assert.equal(call.argv[addDirIdx + 1], '.');
  assert.ok(call.argv.includes('-p'));
  const pIdx = call.argv.indexOf('-p');
  assert.equal(call.argv[pIdx + 1], 'Read MISSION.md and acknowledge.');
  assert.ok(call.argv.includes('--output-format'));
  assert.equal(call.argv[call.argv.indexOf('--output-format') + 1], 'json');
});

test('prime transport result, not model wording, decides login success', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
  });
  t.after(() => ws.cleanup());
  // The model's response text mentions not logged in, but the transport succeeded (exit 0, status SUCCESS)
  const stub = makeStubAgy(t, {
    prime: {
      result: 'I am not logged in to Google Antigravity right now. Please log in.',
      status: 'SUCCESS',
      exitCode: 0,
    },
  });

  const { code, stdout } = await runAdapter(ws, stub.cliString, {
    op: 'prime',
    instruction: 'Read context.',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.equal(response.session, 'stub-conv-agy-123');
});

test('prime reports not-logged-in when transport fails with authentication required', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
  });
  t.after(() => ws.cleanup());
  const stub = makeStubAgy(t, {
    prime: {
      exitCode: 1,
      stderr: 'Error: authentication required. Run agy /login.',
    },
  });

  const { code, stdout } = await runAdapter(ws, stub.cliString, {
    op: 'prime',
    instruction: 'Read context.',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'not-logged-in');
  assert.equal(response.error.message, 'Antigravity CLI (agy) is not logged in.');
  assert.equal(response.error.hint, 'Start agy and run /login, then press Retry.');
});

test('send resumes session by conversation id with extra-folder argument from workspace', async (t) => {
  const ws = makeWorkspace({
    'lessons/0001-loops.html': '<h1>Loops</h1>',
  });
  t.after(() => ws.cleanup());
  const stub = makeStubAgy(t, {
    send: {
      result: 'A while loop repeats until a condition is met.',
    },
  });

  const { code, stdout } = await runAdapter(ws, stub.cliString, {
    op: 'send',
    session: 'conv-session-xyz',
    lesson: 'lessons/0001-loops.html',
    text: '[sent from lessons/0001-loops.html]\nExplain while loops',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.equal(response.text, 'A while loop repeats until a condition is met.');

  const calls = stub.calls();
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(path.resolve(call.cwd), path.resolve(ws.dir));
  assert.ok(call.argv.includes('--add-dir'));
  assert.equal(call.argv[call.argv.indexOf('--add-dir') + 1], '.');
  assert.ok(call.argv.includes('--conversation'));
  assert.equal(call.argv[call.argv.indexOf('--conversation') + 1], 'conv-session-xyz');
  assert.ok(call.argv.includes('-p'));
  assert.equal(call.argv[call.argv.indexOf('-p') + 1], '[sent from lessons/0001-loops.html]\nExplain while loops');
});

test('prime and send map unauthorised failure with fixed hint and safe message', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubAgy(t, {
    prime: {
      exitCode: 1,
      stderr: 'Request failed with status 401 Unauthorized',
    },
  });

  const { code, stdout } = await runAdapter(ws, stub.cliString, {
    op: 'prime',
    instruction: 'Init',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unauthorised');
  assert.equal(response.error.message, 'Antigravity credentials were not accepted.');
  assert.equal(response.error.hint, 'Start agy and run /login, then press Retry.');
});

test('prime and send map unreachable failure with fixed hint and safe message', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubAgy(t, {
    send: {
      exitCode: 1,
      stderr: 'connect ECONNREFUSED 127.0.0.1:443: network unreachable',
    },
  });

  const { code, stdout } = await runAdapter(ws, stub.cliString, {
    op: 'send',
    session: 'conv-123',
    text: 'Test',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unreachable');
  assert.equal(response.error.message, 'Antigravity CLI (agy) could not reach the server.');
  assert.equal(response.error.hint, 'Check your internet connection and try again.');
});

test('adapter maps timeout with fixed hint and safe message', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubAgy(t, {
    send: {
      delayMs: 500,
      result: 'Late answer',
    },
  });

  const { code, stdout } = await runAdapter(
    ws,
    stub.cliString,
    { op: 'send', session: 'conv-123', text: 'Timeout test' },
    ['--timeout', '50']
  );

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'timeout');
  assert.equal(response.error.message, 'Antigravity CLI (agy) took too long to reply.');
  assert.equal(response.error.hint, 'Press Try again to retry the request.');
});

test('adapter passes the conformance runner end-to-end against stub agy', async (t) => {
  const { startServer } = require('../bridge/server');
  const { awaitVerdict } = require('./handshake-helpers');
  const { get, openTab, HOLDER } = require('./helpers');

  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>',
  });
  const stub = makeStubAgy(t, {
    version: { exitCode: 0, output: '1.2.7\n' },
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
  assert.ok(state.permissions.includes('File reading and editing in the workspace'));

  // Send a message through the server and verify chat round trip
  const sendRes = await fetch(`http://127.0.0.1:${server.port}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Teach-Token': server.token,
      'X-Teach-Tab': HOLDER,
    },
    body: JSON.stringify({ id: 'msg-agy-1', lesson: '/lessons/0001-loops.html', text: 'Hello' }),
  });
  assert.equal(sendRes.status, 202);

  // Poll for reply
  let reply;
  for (let i = 0; i < 20; i++) {
    const res = await (await get(server, '/reply/msg-agy-1')).json();
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

test('conformance check transitions to static with fixed hint when agy is not logged in', async (t) => {
  const { startServer } = require('../bridge/server');
  const { awaitVerdict } = require('./handshake-helpers');
  const { openTab, HOLDER } = require('./helpers');

  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>',
  });
  const stub = makeStubAgy(t, {
    version: { exitCode: 0, output: '1.2.7\n' },
    prime: { exitCode: 1, stderr: 'authentication required' },
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
  assert.equal(state.hint, 'Start agy and run /login, then press Retry.');
});

test('profile table contains antigravity entry pointing at this adapter', () => {
  const profile = getProfile('antigravity');
  assert.ok(profile, 'antigravity profile exists');
  assert.equal(profile.id, 'antigravity');
  assert.equal(profile.remote, false);
  assert.equal(profile.cli, 'agy');
  assert.ok(profile.installHint.includes('Install the Antigravity CLI (agy)'));
  assert.ok(profile.installHint.includes('known install folder'));
  assert.ok(profile.installHint.includes('restart'));
  assert.equal(profile.loginHint, 'Start agy and run /login, then press Retry.');
  assert.equal(path.resolve(profile.adapter[1]), path.resolve(ADAPTER_PATH));
});
