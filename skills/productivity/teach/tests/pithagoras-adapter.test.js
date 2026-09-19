'use strict';
// Tests for the Pithagoras adapter: implements check, prime and send against a stub `pi`
// CLI executable (modelled on the real pi CLI) according to the adapter contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeWorkspace, openTab, HOLDER, get } = require('./helpers');
const { makeStubPi } = require('./pithagoras-helpers');
const { startServer } = require('../bridge/server');
const { awaitVerdict } = require('./handshake-helpers');
const { getProfile } = require('../bridge/profiles');
const {
  PITHAGORAS_PERMISSIONS_WEB,
  PITHAGORAS_PERMISSIONS_NO_WEB,
  WEB_SEARCH_INSTRUCTION,
  shimCommand,
} = require('../bridge/adapters/pithagoras');

const ADAPTER_PATH = path.join(__dirname, '..', 'bridge', 'adapters', 'pithagoras.js');

function runAdapter(workspace, cliString, request, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [ADAPTER_PATH];
    if (cliString) args.push('--cli', cliString);
    if (options.timeoutMs) args.push('--timeout', String(options.timeoutMs));

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

// The message pi received: everything after the `--` that ends option parsing.
function messageOf(call) {
  return call.argv.slice(call.argv.indexOf('--') + 1).join(' ');
}

function flagValue(call, flag) {
  const i = call.argv.indexOf(flag);
  return i === -1 ? undefined : call.argv[i + 1];
}

// ---------------------------------------------------------------------------
// check: package detection and permission text
// ---------------------------------------------------------------------------
test('check without pi-web-access says web research is unavailable', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { list: { packages: ['npm:pi-subagents'] } });

  const { code, stdout } = await runAdapter(ws, stub.cliString, { op: 'check' });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.type, 'result');
  assert.equal(response.ok, true);
  assert.equal(response.permissions, PITHAGORAS_PERMISSIONS_NO_WEB);
  assert.match(response.permissions, /full permissions/i);
  assert.match(response.permissions, /no approval prompts/i);
  assert.equal(response.hasWebAccess, false);
});

test('check with pi-web-access installed says the agent can search and fetch', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { list: { packages: ['npm:pi-web-access', 'npm:pi-subagents'] } });

  const { code, stdout } = await runAdapter(ws, stub.cliString, { op: 'check' });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.ok, true);
  assert.equal(response.permissions, PITHAGORAS_PERMISSIONS_WEB);
  assert.match(response.permissions, /pi-web-access/);
  assert.equal(response.hasWebAccess, true);

  // The check uses the real `pi list` command, not an invented subcommand.
  const calls = stub.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['list']);
});

test('the adapter never reads or writes the global web-search config', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const home = path.join(ws.dir, 'fake-home');
  fs.mkdirSync(path.join(home, '.pi'), { recursive: true });
  const configFile = path.join(home, '.pi', 'web-search.json');
  fs.writeFileSync(configFile, '{"workflow":"auto-summary"}');
  const before = fs.statSync(configFile).mtimeMs;
  const stub = makeStubPi(t, { prime: { text: 'ok' } });
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  await runAdapter(ws, stub.cliString, { op: 'check' }, { env });
  await runAdapter(ws, stub.cliString, { op: 'prime', instruction: 'Read only.' }, { env });

  assert.equal(fs.readFileSync(configFile, 'utf8'), '{"workflow":"auto-summary"}');
  assert.equal(fs.statSync(configFile).mtimeMs, before);
});

// ---------------------------------------------------------------------------
// Error mappings and fixed hints
// ---------------------------------------------------------------------------
test('check reports missing when pi executable cannot be found', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const nonExistentCli = JSON.stringify([path.join(ws.dir, 'does-not-exist', 'pi.exe')]);

  const { code, stdout } = await runAdapter(ws, nonExistentCli, { op: 'check' });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'missing');
  assert.equal(response.error.message, 'pi CLI is not installed.');
  assert.equal(response.error.hint, 'Install the pi CLI and make sure it is on your PATH, then press Retry.');
});

test('a failing pi list is a plain failure', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { list: { exitCode: 1, stderr: 'boom' } });

  const { stdout } = await runAdapter(ws, stub.cliString, { op: 'check' });

  const response = JSON.parse(stdout.trim());
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'failed');
});

const PRIME_FAILURES = [
  {
    code: 'not-logged-in',
    turn: { stopReason: 'error', errorMessage: 'No API key found for google. Use /login or set an API key.', text: '' },
    message: 'pi has no credentials for its model provider.',
    hint: 'Run pi and use /login, or set your provider API key, then press Retry.',
  },
  {
    code: 'unauthorised',
    turn: { stopReason: 'error', errorMessage: '401 Unauthorized: Invalid API key', text: '' },
    message: 'pi credentials were not accepted.',
    hint: 'Check your pi provider credentials or API key, then press Retry.',
  },
  {
    code: 'unreachable',
    turn: { stopReason: 'error', errorMessage: 'Connection error: fetch failed', text: '' },
    message: 'pi could not reach its model provider.',
    hint: 'Check that your model provider is running and reachable, then press Retry.',
  },
];

for (const failureCase of PRIME_FAILURES) {
  test(`prime maps a model error to ${failureCase.code} with a fixed hint`, async (t) => {
    const ws = makeWorkspace({});
    t.after(() => ws.cleanup());
    const stub = makeStubPi(t, { prime: failureCase.turn });

    const { code, stdout } = await runAdapter(ws, stub.cliString, { op: 'prime', instruction: 'Read only.' });

    assert.equal(code, 0);
    const response = JSON.parse(stdout.trim());
    assert.equal(response.type, 'result');
    assert.equal(response.ok, false);
    assert.equal(response.error.code, failureCase.code);
    assert.equal(response.error.message, failureCase.message);
    assert.equal(response.error.hint, failureCase.hint);
  });
}

test('a pi process that exits non-zero is classified from its output', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { send: { exitCode: 1, stderr: 'connect ECONNREFUSED 127.0.0.1:8080' } });

  const { stdout } = await runAdapter(ws, stub.cliString, { op: 'send', session: 's', text: 'Hello' });

  const response = JSON.parse(stdout.trim());
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unreachable');
});

test('output with no assistant reply is a failure, not an empty success', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { send: { rawOutput: '{"type":"session","id":"x"}\n' } });

  const { stdout } = await runAdapter(ws, stub.cliString, { op: 'send', session: 's', text: 'Hello' });

  const response = JSON.parse(stdout.trim());
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'failed');
});

test('timeout during turn yields timeout with fixed hint', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { send: { delayMs: 500, text: 'Too late' } });

  const { code, stdout } = await runAdapter(
    ws,
    stub.cliString,
    { op: 'send', session: 'sess-timeout', text: 'Hello' },
    { timeoutMs: 50 },
  );

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'timeout');
  assert.equal(response.error.message, 'pi took too long to reply.');
  assert.equal(response.error.hint, 'The agent may still be working in the background. Press Try again to retry.');
});

// ---------------------------------------------------------------------------
// Web search workflow: none, per call, no global config change
// ---------------------------------------------------------------------------
test('every turn tells the agent to search with workflow none', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { prime: { text: 'Ready.' }, send: { text: 'An answer.' } });

  await runAdapter(ws, stub.cliString, { op: 'prime', instruction: 'Read only.' });
  await runAdapter(ws, stub.cliString, { op: 'send', session: 'sess-1', text: 'Why?' });

  const calls = stub.calls();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(flagValue(call, '--append-system-prompt'), WEB_SEARCH_INSTRUCTION);
  }
  assert.match(WEB_SEARCH_INSTRUCTION, /workflow: "none"/);
  assert.match(WEB_SEARCH_INSTRUCTION, /straight back/);
});

// ---------------------------------------------------------------------------
// Replies come from the real JSON event stream
// ---------------------------------------------------------------------------
test('the reply is the text of the last assistant message, not the thinking or raw events', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { send: { text: 'Loops repeat work.' } });

  const { stdout } = await runAdapter(ws, stub.cliString, { op: 'send', session: 's', text: 'What is a loop?' });

  const response = JSON.parse(stdout.trim());
  assert.equal(response.ok, true);
  assert.equal(response.text, 'Loops repeat work.');
});

// ---------------------------------------------------------------------------
// Learner text reaches pi as one message argument
// ---------------------------------------------------------------------------
test('learner text is passed after -- so leading dashes are not read as flags', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { send: { text: 'Explained.' } });

  const { stdout } = await runAdapter(ws, stub.cliString, { op: 'send', session: 's', text: '--help me with loops' });

  assert.equal(JSON.parse(stdout.trim()).ok, true);
  assert.equal(messageOf(stub.calls()[0]), '--help me with loops');
});

test('learner text starting with @ is not left to be read as a file', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { send: { text: 'Explained.' } });

  const { stdout } = await runAdapter(ws, stub.cliString, { op: 'send', session: 's', text: '@teacher what is a loop?' });

  assert.equal(JSON.parse(stdout.trim()).ok, true);
  const message = messageOf(stub.calls()[0]);
  assert.ok(!message.startsWith('@'), `message must not start with @: ${message}`);
  assert.ok(message.includes('@teacher what is a loop?'));
});

test('a bare stop word is an ordinary message to the pi CLI', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { send: { text: 'Okay.' } });

  const { stdout } = await runAdapter(ws, stub.cliString, { op: 'send', session: 's', text: 'stop' });

  assert.equal(JSON.parse(stdout.trim()).ok, true);
  assert.equal(messageOf(stub.calls()[0]), 'stop');
});

// ---------------------------------------------------------------------------
// Prime and send operations
// ---------------------------------------------------------------------------
test('prime generates session id, runs from workspace, and passes instruction as one arg', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-intro.html': '<h1>Intro</h1>',
  });
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { prime: { text: 'Ready to teach.' } });

  const instruction = 'You are the teacher for this workspace. Read only.';
  const { code, stdout } = await runAdapter(ws, stub.cliString, {
    op: 'prime',
    lesson: 'lessons/0001-intro.html',
    instruction,
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.ok, true);
  assert.ok(typeof response.session === 'string' && response.session);

  const calls = stub.calls();
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.cwd, ws.dir);
  assert.ok(call.argv.includes('-p'));
  assert.equal(flagValue(call, '--mode'), 'json');
  assert.equal(messageOf(call), instruction);
  assert.equal(flagValue(call, '--session-id'), response.session);
});

test('send resumes session, runs from workspace, and passes text as one arg', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-intro.html': '<h1>Intro</h1>',
  });
  t.after(() => ws.cleanup());
  const stub = makeStubPi(t, { send: { text: 'Python is a high-level language.' } });

  const { code, stdout } = await runAdapter(ws, stub.cliString, {
    op: 'send',
    session: 'sess-abc-123',
    lesson: 'lessons/0001-intro.html',
    text: 'What is Python?',
  });

  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.ok, true);
  assert.equal(response.text, 'Python is a high-level language.');

  const calls = stub.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, ws.dir);
  assert.equal(messageOf(calls[0]), 'What is Python?');
  assert.equal(flagValue(calls[0], '--session-id'), 'sess-abc-123');
});

// ---------------------------------------------------------------------------
// Conformance runner integration
// ---------------------------------------------------------------------------
test('adapter passes the conformance runner against the stub CLI', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-intro.html': '<!doctype html><html><body><h1>Intro</h1></body></html>',
  });
  const stub = makeStubPi(t, {
    prime: { text: 'Understood and ready.' },
    send: { text: 'Python is an interpreted programming language.' },
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
  assert.equal(state.permissions, PITHAGORAS_PERMISSIONS_WEB);

  // Verify chat send works through the server
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
  assert.equal(reply.result.text, 'Python is an interpreted programming language.');
});

test('conformance check transitions to static with the login hint when the prime turn shows no credentials', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-intro.html': '<!doctype html><html><body><h1>Intro</h1></body></html>',
  });
  const stub = makeStubPi(t, {
    prime: {
      stopReason: 'error',
      errorMessage: 'No API key found for google. Use /login or set an API key.',
      text: '',
    },
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
  assert.equal(state.message, 'pi has no credentials for its model provider.');
  assert.equal(state.hint, 'Run pi and use /login, or set your provider API key, then press Retry.');
});

// ---------------------------------------------------------------------------
// Profile table entry
// ---------------------------------------------------------------------------
test('profile table gains the pithagoras entry (adapter, remote, cli: pi)', () => {
  const profile = getProfile('pithagoras');
  assert.ok(profile, 'profile exists for pithagoras');
  assert.equal(profile.id, 'pithagoras');
  assert.equal(profile.remote, true);
  assert.equal(profile.cli, 'pi');
  assert.ok(profile.installHint);
  assert.ok(profile.loginHint);

  assert.ok(Array.isArray(profile.adapter), 'adapter is a command array');
  assert.equal(profile.adapter[0], process.execPath);
  assert.equal(path.resolve(profile.adapter[1]), path.resolve(ADAPTER_PATH));
});

// ---------------------------------------------------------------------------
// Windows npm shim: Node cannot spawn a .cmd without a shell
// ---------------------------------------------------------------------------
test('a Windows npm .cmd shim resolves to the node script it runs', (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const script = path.join(ws.dir, 'node_modules', 'pkg', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '');
  const shim = path.join(ws.dir, 'pi.cmd');
  fs.writeFileSync(
    shim,
    '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\dist\\cli.js" %*\r\n',
  );

  assert.deepEqual(shimCommand(shim), [process.execPath, script]);
});

test('a shim that names a missing script, or no script, resolves to nothing', (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const missing = path.join(ws.dir, 'missing.cmd');
  fs.writeFileSync(missing, '"%_prog%"  "%dp0%\\node_modules\\gone\\cli.js" %*\r\n');
  const plain = path.join(ws.dir, 'plain.cmd');
  fs.writeFileSync(plain, '@ECHO off\r\necho hi\r\n');

  assert.equal(shimCommand(missing), null);
  assert.equal(shimCommand(plain), null);
  assert.equal(shimCommand(path.join(ws.dir, 'absent.cmd')), null);
});
