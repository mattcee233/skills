'use strict';
// Session start, harness detection, address binding, URL reply, and outcome recording.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeWorkspace } = require('./helpers');
const {
  detectHarness,
  QUESTION_HARNESS,
} = require('../bridge/session');

test('detectHarness resolves claude-code when self-report and environment agree', () => {
  const result = detectHarness({
    selfReport: { harness: 'claude-code', reason: 'Running inside Claude Code with Agent SDK tools.' },
    env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
  });
  assert.equal(result.resolved, true);
  assert.equal(result.harness, 'claude-code');
  assert.ok(result.profile);
  assert.equal(result.profile.id, 'claude-code');
  assert.match(result.assumption, /Assuming Claude Code/i);
  assert.match(result.assumption, /Running inside Claude Code with Agent SDK tools/);
});

test('detectHarness resolves pithagoras when self-report and environment agree', () => {
  const result = detectHarness({
    selfReport: { harness: 'pithagoras', reason: 'Instructions identify pi agent harness.' },
    env: { PI_SESSION_ID: 'sess-123', AGENT_HOME: '/opt/pithagoras' },
  });
  assert.equal(result.resolved, true);
  assert.equal(result.harness, 'pithagoras');
  assert.ok(result.profile);
  assert.equal(result.profile.id, 'pithagoras');
  assert.match(result.assumption, /Assuming Pithagoras/i);
});

test('detectHarness resolves antigravity when self-report says antigravity and no conflicting markers exist', () => {
  const result = detectHarness({
    selfReport: { harness: 'antigravity', reason: 'System instructions mention Antigravity.' },
    env: {},
  });
  assert.equal(result.resolved, true);
  assert.equal(result.harness, 'antigravity');
  assert.ok(result.profile);
  assert.equal(result.profile.id, 'antigravity');
  assert.match(result.assumption, /Assuming Antigravity/i);
});

test('detectHarness detects conflict between self-report and environment markers and asks a one-line question', () => {
  // Claude Code reported, but Pithagoras env markers present
  const conflict1 = detectHarness({
    selfReport: { harness: 'claude-code', reason: 'I think I am Claude Code.' },
    env: { PI_SESSION_ID: 'sess-456' },
  });
  assert.equal(conflict1.resolved, false);
  assert.equal(conflict1.conflict, true);
  assert.equal(conflict1.question, QUESTION_HARNESS);

  // Pithagoras reported, but Claude Code env markers present
  const conflict2 = detectHarness({
    selfReport: { harness: 'pithagoras', reason: 'I think I am Pithagoras.' },
    env: { CLAUDECODE: '1' },
  });
  assert.equal(conflict2.resolved, false);
  assert.equal(conflict2.conflict, true);
  assert.equal(conflict2.question, QUESTION_HARNESS);

  // Antigravity reported, but Claude Code env markers present
  const conflict3 = detectHarness({
    selfReport: { harness: 'antigravity', reason: 'I think I am Antigravity.' },
    env: { CLAUDECODE: '1' },
  });
  assert.equal(conflict3.resolved, false);
  assert.equal(conflict3.conflict, true);
  assert.equal(conflict3.question, QUESTION_HARNESS);
});

test('detectHarness treats "other" or unknown self-report as inconclusive and asks learner', () => {
  const other = detectHarness({
    selfReport: { harness: 'other', reason: 'Unrecognised custom IDE harness.' },
    env: {},
  });
  assert.equal(other.resolved, false);
  assert.equal(other.inconclusive, true);
  assert.equal(other.question, QUESTION_HARNESS);
});

test('determineBindOptions for remote harness (pithagoras) never offers "this computer"', () => {
  const { determineBindOptions } = require('../bridge/session');
  const profile = { id: 'pithagoras', remote: true };

  // Multiple private addresses -> must ask which address
  const multi = determineBindOptions({ profile, addresses: ['192.168.1.50', '10.0.0.5'] });
  assert.equal(multi.canOfferLoopback, false);
  assert.equal(multi.mode, 'network');
  assert.equal(multi.mustAskAddress, true);
  assert.deepEqual(multi.addresses, ['192.168.1.50', '10.0.0.5']);
  assert.match(multi.question, /192\.168\.1\.50/);

  // Single private address -> automatically picks that address
  const single = determineBindOptions({ profile, addresses: ['192.168.1.50'] });
  assert.equal(single.canOfferLoopback, false);
  assert.equal(single.mode, 'network');
  assert.equal(single.mustAskAddress, false);
  assert.equal(single.bind.mode, 'network');
  assert.equal(single.bind.address, '192.168.1.50');
});

test('determineBindOptions for desktop harness (claude-code) defaults to this computer only', () => {
  const { determineBindOptions } = require('../bridge/session');
  const profile = { id: 'claude-code', remote: false };

  const opts = determineBindOptions({ profile, addresses: ['192.168.1.50'] });
  assert.equal(opts.canOfferLoopback, true);
  assert.equal(opts.defaultChoice, 'loopback');
  assert.equal(opts.bind.mode, 'loopback');
  assert.match(opts.question, /this computer only/i);
});

test('determineBindOptions for unrecognised harness asks with no default', () => {
  const { determineBindOptions } = require('../bridge/session');

  const opts = determineBindOptions({ profile: null, addresses: ['192.168.1.50'] });
  assert.equal(opts.canOfferLoopback, true);
  assert.equal(opts.defaultChoice, null);
  assert.equal(opts.mustAskMode, true);
  assert.match(opts.question, /this computer only/i);
});

test('resolveBind returns loopback or network configuration', () => {
  const { resolveBind } = require('../bridge/session');

  assert.deepEqual(resolveBind({ mode: 'loopback' }), { mode: 'loopback' });
  assert.deepEqual(resolveBind({ mode: 'network', address: '192.168.1.100' }), {
    mode: 'network',
    address: '192.168.1.100',
  });
  assert.deepEqual(resolveBind({ mode: 'network', addresses: ['192.168.1.100'] }), {
    mode: 'network',
    address: '192.168.1.100',
  });
});

test('formatLessonUrl builds URL opening current lesson with token only in fragment', () => {
  const { formatLessonUrl } = require('../bridge/session');

  // Loopback mode
  const url1 = formatLessonUrl({
    port: 54321,
    token: 'tok-sec-12345',
    lesson: 'lessons/0001-intro.html',
    bindMode: 'loopback',
  });
  assert.equal(url1, 'http://localhost:54321/lessons/0001-intro.html#t=tok-sec-12345');

  const parsed1 = new URL(url1);
  assert.equal(parsed1.hostname, 'localhost');
  assert.equal(parsed1.port, '54321');
  assert.equal(parsed1.pathname, '/lessons/0001-intro.html');
  assert.equal(parsed1.search, ''); // no token in query!
  assert.equal(parsed1.hash, '#t=tok-sec-12345');

  // Network mode
  const url2 = formatLessonUrl({
    port: 54321,
    token: 'tok-sec-12345',
    lesson: './lessons/0002-loops.html',
    bindMode: 'network',
    bindAddress: '192.168.1.88',
  });
  assert.equal(url2, 'http://192.168.1.88:54321/lessons/0002-loops.html#t=tok-sec-12345');

  const parsed2 = new URL(url2);
  assert.equal(parsed2.hostname, '192.168.1.88');
  assert.equal(parsed2.port, '54321');
  assert.equal(parsed2.pathname, '/lessons/0002-loops.html');
  assert.equal(parsed2.search, '');
  assert.equal(parsed2.hash, '#t=tok-sec-12345');
});

test('pollLauncherStatus reports "chat is ready" when status is interactive', async () => {
  const { pollLauncherStatus } = require('../bridge/session');

  let calls = 0;
  const mockQuery = async () => {
    calls++;
    if (calls === 1) return { state: 'pending' };
    return { state: 'interactive', permissions: 'Workspace files and browser' };
  };

  const result = await pollLauncherStatus({
    port: 1234,
    token: 'dummy',
    maxWaitMs: 2000,
    pollIntervalMs: 10,
    queryFn: mockQuery,
  });

  assert.equal(result.state, 'interactive');
  assert.equal(result.verdict, 'chat is ready');
});

test('pollLauncherStatus reports one-line reason and fix when status is static', async () => {
  const { pollLauncherStatus } = require('../bridge/session');

  const mockQuery = async () => ({
    state: 'static',
    reason: 'not-logged-in',
    message: 'Claude Code is not logged in.',
    hint: 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.',
  });

  const result = await pollLauncherStatus({
    port: 1234,
    token: 'dummy',
    maxWaitMs: 2000,
    pollIntervalMs: 10,
    queryFn: mockQuery,
  });

  assert.equal(result.state, 'static');
  assert.equal(result.reason, 'not-logged-in');
  assert.equal(
    result.verdict,
    'Claude Code is not logged in. Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.'
  );
});

test('pollLauncherStatus reports "still connecting" when timeout expires while pending', async () => {
  const { pollLauncherStatus } = require('../bridge/session');

  const mockQuery = async () => ({ state: 'pending' });

  const result = await pollLauncherStatus({
    port: 1234,
    token: 'dummy',
    maxWaitMs: 50,
    pollIntervalMs: 10,
    queryFn: mockQuery,
  });

  assert.equal(result.state, 'pending');
  assert.equal(result.verdict, 'still connecting');
});

test('recordSessionOutcome records ok, login-failed, declined, no-node and skips other failures', () => {
  const { recordSessionOutcome } = require('../bridge/session');
  const { readConfig, writeConfig } = require('../bridge/setup');

  const ws = makeWorkspace();
  try {
    writeConfig(ws.dir, { version: 1, adapter: null, cli: 'claude', outcome: { status: 'ok', cli: 'claude', date: '2026-01-01', hint: null } });

    // 1. ok
    const resOk = recordSessionOutcome(ws.dir, { status: 'ok', cli: 'claude' });
    assert.equal(resOk.recorded, true);
    assert.equal(readConfig(ws.dir).outcome.status, 'ok');

    // 2. login-failed with hint
    const resLogin = recordSessionOutcome(ws.dir, {
      status: 'static',
      reason: 'not-logged-in',
      hint: 'Run "claude auth login" then retry.',
      cli: 'claude',
    });
    assert.equal(resLogin.recorded, true);
    const cfgLogin = readConfig(ws.dir);
    assert.equal(cfgLogin.outcome.status, 'login-failed');
    assert.equal(cfgLogin.outcome.hint, 'Run "claude auth login" then retry.');

    // 3. other failures (missing, unreachable, conformance, timeout) are NOT recorded
    const beforeDate = cfgLogin.outcome.date;
    const resMissing = recordSessionOutcome(ws.dir, {
      status: 'static',
      reason: 'missing',
      hint: 'Install Claude Code',
      cli: 'claude',
    });
    assert.equal(resMissing.recorded, false);
    assert.equal(readConfig(ws.dir).outcome.status, 'login-failed'); // untouched!
    assert.equal(readConfig(ws.dir).outcome.date, beforeDate);

    const resTimeout = recordSessionOutcome(ws.dir, {
      status: 'static',
      reason: 'timeout',
      cli: 'claude',
    });
    assert.equal(resTimeout.recorded, false);
    assert.equal(readConfig(ws.dir).outcome.status, 'login-failed');

    // 4. declined
    const resDeclined = recordSessionOutcome(ws.dir, { status: 'declined' });
    assert.equal(resDeclined.recorded, true);
    assert.equal(readConfig(ws.dir).outcome.status, 'declined');

    // 5. no-node
    const resNoNode = recordSessionOutcome(ws.dir, { status: 'no-node', hint: 'Install Node 18+' });
    assert.equal(resNoNode.recorded, true);
    assert.equal(readConfig(ws.dir).outcome.status, 'no-node');
    assert.equal(readConfig(ws.dir).outcome.hint, 'Install Node 18+');
  } finally {
    ws.cleanup();
  }
});

test('getSessionStartNotice is silent after declined or ok, but gives one line after login-failed or no-node', () => {
  const { getSessionStartNotice } = require('../bridge/session');
  const { writeConfig } = require('../bridge/setup');

  const ws = makeWorkspace();
  try {
    // declined -> silent
    writeConfig(ws.dir, { version: 1, outcome: { status: 'declined', cli: null, date: '2026-09-19', hint: null } });
    const noticeDeclined = getSessionStartNotice(ws.dir);
    assert.equal(noticeDeclined.silent, true);
    assert.equal(noticeDeclined.notice, null);
    assert.equal(noticeDeclined.canStart, false);

    // ok -> silent
    writeConfig(ws.dir, { version: 1, outcome: { status: 'ok', cli: 'claude', date: '2026-09-19', hint: null } });
    const noticeOk = getSessionStartNotice(ws.dir);
    assert.equal(noticeOk.silent, true);
    assert.equal(noticeOk.notice, null);
    assert.equal(noticeOk.canStart, true);

    // login-failed -> one line with the hint
    writeConfig(ws.dir, {
      version: 1,
      outcome: {
        status: 'login-failed',
        cli: 'claude',
        date: '2026-09-19',
        hint: 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.',
      },
    });
    const noticeLogin = getSessionStartNotice(ws.dir);
    assert.equal(noticeLogin.silent, false);
    assert.match(noticeLogin.notice, /claude auth login/i);
    assert.equal(noticeLogin.notice.includes('\n'), false); // one line!

    // no-node -> one line
    writeConfig(ws.dir, {
      version: 1,
      outcome: {
        status: 'no-node',
        cli: null,
        date: '2026-09-19',
        hint: 'Install Node 18 or later to use interactive mode.',
      },
    });
    const noticeNoNode = getSessionStartNotice(ws.dir);
    assert.equal(noticeNoNode.silent, false);
    assert.match(noticeNoNode.notice, /Node 18/i);
    assert.equal(noticeNoNode.canStart, false);
  } finally {
    ws.cleanup();
  }
});

test('startSession on Claude Code starts server, replies with URL and "chat is ready", and records ok', async (t) => {
  const { startSession } = require('../bridge/session');
  const { makeStubClaude } = require('./claude-helpers');
  const { readConfig } = require('../bridge/setup');

  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>',
  });
  const stub = makeStubClaude(t, {
    authStatus: { exitCode: 0 },
    prime: { result: 'Acknowledged.' },
  });

  const adapterCmd = [process.execPath, path.join(__dirname, '..', 'bridge', 'adapters', 'claude-code.js'), '--cli', stub.cliString];

  const session = await startSession({
    workspace: ws.dir,
    harness: 'claude-code',
    adapter: adapterCmd,
    pollTimeoutMs: 5000,
    pollIntervalMs: 50,
  });

  t.after(async () => {
    if (session.server) await session.server.close();
    ws.cleanup();
  });

  assert.equal(session.active, true);
  assert.equal(session.status, 'interactive');
  assert.equal(session.verdict, 'chat is ready');
  assert.ok(session.url);
  assert.match(session.url, /http:\/\/localhost:\d+\/lessons\/0001-loops\.html#t=[a-f0-9]{64}/);
  assert.match(session.reply, /http:\/\/localhost:\d+\/lessons\/0001-loops\.html#t=[a-f0-9]{64}/);
  assert.match(session.reply, /chat is ready/);

  // Check config was recorded as ok
  const cfg = readConfig(ws.dir);
  assert.equal(cfg.outcome.status, 'ok');
  assert.equal(cfg.outcome.hint, null);
});

test('startSession stops leftover server from earlier invocation and stores nothing about port in config', async (t) => {
  const { startSession } = require('../bridge/session');
  const { makeStubClaude } = require('./claude-helpers');
  const { readConfig } = require('../bridge/setup');
  const { spawn } = require('node:child_process');

  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>',
  });
  const stub = makeStubClaude(t, { authStatus: { exitCode: 0 }, prime: { result: 'Acknowledged.' } });
  const adapterCmd = [process.execPath, path.join(__dirname, '..', 'bridge', 'adapters', 'claude-code.js'), '--cli', stub.cliString];

  // A server from an earlier invocation, running as its own process.
  const leftover = spawn(process.execPath, [path.join(__dirname, 'leftover-server.js'), ws.dir], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => leftover.kill());
  const port1 = Number((await new Promise((resolve) => leftover.stdout.once('data', resolve))).toString().split(' ')[1]);
  const identity = await (await fetch(`http://127.0.0.1:${port1}/_teach/identity`)).json();
  assert.equal(identity.teach, true);

  const session2 = await startSession({
    workspace: ws.dir,
    harness: 'claude-code',
    adapter: adapterCmd,
    bind: { mode: 'loopback' },
    pollTimeoutMs: 5000,
    pollIntervalMs: 50,
  });
  t.after(async () => {
    if (session2.server) await session2.server.close();
    ws.cleanup();
  });

  let leftoverAlive = true;
  try {
    await fetch(`http://127.0.0.1:${port1}/_teach/identity`, { signal: AbortSignal.timeout(500) });
  } catch {
    leftoverAlive = false;
  }
  assert.equal(leftoverAlive, false, 'leftover server was stopped');

  // Nothing about port or address is stored in config
  const cfg = readConfig(ws.dir);
  assert.equal(cfg.port, undefined);
  assert.equal(cfg.address, undefined);
  assert.equal(cfg.bind, undefined);
});

test('startSession on Claude Code with login failure reports reason/fix and records login-failed', async (t) => {
  const { startSession } = require('../bridge/session');
  const { makeStubClaude } = require('./claude-helpers');
  const { readConfig } = require('../bridge/setup');

  const ws = makeWorkspace({
    'MISSION.md': 'Learn Python.',
    'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>',
  });
  const stub = makeStubClaude(t, {
    authStatus: { exitCode: 1 },
  });

  const adapterCmd = [process.execPath, path.join(__dirname, '..', 'bridge', 'adapters', 'claude-code.js'), '--cli', stub.cliString];

  const session = await startSession({
    workspace: ws.dir,
    harness: 'claude-code',
    adapter: adapterCmd,
    pollTimeoutMs: 5000,
    pollIntervalMs: 50,
  });

  t.after(async () => {
    if (session.server) await session.server.close();
    ws.cleanup();
  });

  assert.equal(session.active, true);
  assert.equal(session.status, 'static');
  assert.equal(session.reason, 'not-logged-in');
  assert.match(session.verdict, /claude auth login/i);
  assert.match(session.reply, /http:\/\/localhost:\d+\/lessons\/0001-loops\.html#t=/);
  assert.match(session.reply, /claude auth login/i);

  // Recorded login-failed in config
  const cfg = readConfig(ws.dir);
  assert.equal(cfg.outcome.status, 'login-failed');
  assert.match(cfg.outcome.hint, /claude auth login/i);
});

test('startSession when declined does not start server and stays silent', async () => {
  const { startSession } = require('../bridge/session');
  const { writeConfig } = require('../bridge/setup');

  const ws = makeWorkspace();
  try {
    writeConfig(ws.dir, { version: 1, outcome: { status: 'declined', cli: null, date: '2026-09-19', hint: null } });

    const session = await startSession({
      workspace: ws.dir,
      harness: 'claude-code',
    });

    assert.equal(session.active, false);
    assert.equal(session.silent, true);
    assert.equal(session.server, undefined);
  } finally {
    ws.cleanup();
  }
});






test('startSession asks for the address, and starts nothing, when the harness rules out a default', async () => {
  const { startSession } = require('../bridge/session');
  const ws = makeWorkspace({ 'lessons/0001-loops.html': '<h1>Loops</h1>' });
  try {
    const remote = await startSession({ workspace: ws.dir, harness: 'pithagoras', addresses: ['192.168.1.50', '10.0.0.5'] });
    assert.equal(remote.active, false);
    assert.equal(remote.needs, 'bind');
    assert.match(remote.question, /192\.168\.1\.50/);
    assert.equal(remote.server, undefined);

    const unrecognised = await startSession({ workspace: ws.dir, harness: 'other', addresses: ['192.168.1.50'] });
    assert.equal(unrecognised.active, false);
    assert.equal(unrecognised.needs, 'bind');
    assert.match(unrecognised.question, /this computer only/i);
  } finally {
    ws.cleanup();
  }
});

test('the URL opens the newest lesson, and the workspace root when there is none yet', () => {
  const { currentLesson } = require('../bridge/session');
  const ws = makeWorkspace({
    'lessons/0001-loops.html': '<h1>1</h1>',
    'lessons/0003-functions.html': '<h1>3</h1>',
    'lessons/0002-lists.html': '<h1>2</h1>',
    'lessons/notes.txt': 'not a lesson',
  });
  const empty = makeWorkspace();
  try {
    assert.equal(currentLesson(ws.dir), 'lessons/0003-functions.html');
    assert.equal(currentLesson(empty.dir), null);
  } finally {
    ws.cleanup();
    empty.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The commands the agent runs
// ---------------------------------------------------------------------------
const SESSION_CLI = path.join(__dirname, '..', 'bridge', 'session.js');

function runSessionCli(args, env = process.env) {
  const { spawnSync } = require('node:child_process');
  const run = spawnSync(process.execPath, [SESSION_CLI, ...args], { encoding: 'utf8', env });
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
}

test('session.js detect prints the one-line assumption, or the question when unsure', () => {
  const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const known = runSessionCli(['detect', '--harness', 'claude-code', '--reason', 'CLAUDECODE is set'], { ...clean, CLAUDECODE: '1' });
  assert.equal(known.code, 0);
  const resolved = JSON.parse(known.out);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.assumption, 'Assuming Claude Code (CLAUDECODE is set).');

  const conflict = runSessionCli(['detect', '--harness', 'claude-code'], { ...clean, PI_SESSION_ID: 'x' });
  assert.equal(JSON.parse(conflict.out).conflict, true);

  const unsure = runSessionCli(['detect', '--harness', 'other'], clean);
  assert.equal(JSON.parse(unsure.out).resolved, false);
  assert.match(JSON.parse(unsure.out).question, /which application or harness/i);
});

test('session.js bind and notice print what the agent needs to ask or say', () => {
  const ws = makeWorkspace();
  try {
    const desktop = JSON.parse(runSessionCli(['bind', '--harness', 'claude-code']).out);
    assert.equal(desktop.defaultChoice, 'loopback');

    const { writeConfig } = require('../bridge/setup');
    writeConfig(ws.dir, { version: 1, outcome: { status: 'declined', cli: null, date: '2026-09-19', hint: null } });
    const notice = JSON.parse(runSessionCli(['notice', '--workspace', ws.dir]).out);
    assert.equal(notice.silent, true);
    assert.equal(notice.canStart, false);
  } finally {
    ws.cleanup();
  }
});

test('session.js start prints the URL and verdict once, then keeps the server running until stopped', async (t) => {
  const { spawn } = require('node:child_process');
  const { makeStubClaude } = require('./claude-helpers');
  const ws = makeWorkspace({ 'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>' });
  const stub = makeStubClaude(t, { authStatus: { exitCode: 0 }, prime: { result: 'Acknowledged.' } });
  const adapter = JSON.stringify([process.execPath, path.join(__dirname, '..', 'bridge', 'adapters', 'claude-code.js'), '--cli', stub.cliString]);

  const child = spawn(process.execPath, [SESSION_CLI, 'start', '--workspace', ws.dir, '--harness', 'claude-code', '--adapter', adapter], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => {
    child.kill();
    ws.cleanup();
  });

  const line = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(d.toString().trim())));
  const result = JSON.parse(line);
  assert.equal(result.active, true);
  assert.equal(result.status, 'interactive');
  assert.equal(result.verdict, 'chat is ready');
  assert.equal(result.server, undefined, 'the server object is not printed');
  assert.match(result.url, /http:\/\/localhost:\d+\/lessons\/0001-loops\.html#t=[a-f0-9]{64}/);

  // Still serving after the line was printed.
  const port = new URL(result.url).port;
  const identity = await (await fetch(`http://127.0.0.1:${port}/_teach/identity`)).json();
  assert.equal(identity.teach, true);
});

test('session.js start refuses a workspace that does not exist, and unknown commands', () => {
  const missing = runSessionCli(['start', '--workspace', path.join(__dirname, 'no-such-folder'), '--harness', 'claude-code']);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /existing folder/);

  const unknown = runSessionCli(['wander']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /Usage/);
});

test('every session.js command and flag the setup guide tells the agent to run exists', () => {
  const guide = fs.readFileSync(path.join(__dirname, '..', 'INTERACTIVE-SETUP.md'), 'utf8');
  const source = fs.readFileSync(SESSION_CLI, 'utf8');
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');

  const commands = [...guide.matchAll(/session\.js (detect|bind|notice|start|[a-z]+)/g)].map((m) => m[1]);
  assert.ok(commands.length >= 4, 'the guide names the commands');
  for (const command of new Set(commands)) {
    assert.match(source, new RegExp(`command === '${command}'`), `session.js handles "${command}"`);
  }

  const flags = [...guide.matchAll(/session\.js [^\n`]*?--([a-z]+)/g)].map((m) => m[1]);
  const flagsInUse = new Set([...flags, 'workspace', 'harness', 'reason', 'mode', 'address', 'adapter', 'improvised']);
  for (const flag of flagsInUse) {
    assert.ok(source.includes(`flags.${flag}`), `session.js reads --${flag}`);
  }

  assert.match(skill, /INTERACTIVE-SETUP\.md#starting-a-session/, 'SKILL.md points at the session-start steps');
  assert.match(guide, /^## Starting a Session$/m);
});

test('after login-failed the reply opens with the one-line notice, then the link and verdict', async (t) => {
  const { startSession } = require('../bridge/session');
  const { makeStubClaude } = require('./claude-helpers');
  const { writeConfig } = require('../bridge/setup');
  const ws = makeWorkspace({ 'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>' });
  const stub = makeStubClaude(t, { authStatus: { exitCode: 0 }, prime: { result: 'Acknowledged.' } });
  const adapter = [process.execPath, path.join(__dirname, '..', 'bridge', 'adapters', 'claude-code.js'), '--cli', stub.cliString];
  writeConfig(ws.dir, {
    version: 1,
    outcome: { status: 'login-failed', cli: 'claude', date: '2026-09-18', hint: 'Run claude auth login, then try again.' },
  });

  const session = await startSession({ workspace: ws.dir, harness: 'claude-code', adapter, pollTimeoutMs: 5000, pollIntervalMs: 50 });
  t.after(async () => {
    if (session.server) await session.server.close();
    ws.cleanup();
  });

  const lines = session.reply.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /claude auth login/);
  assert.match(lines[1], /^http:\/\/localhost:\d+\/lessons\/0001-loops\.html#t=/);
  assert.equal(lines[2], 'chat is ready');
});

test('the server binds exactly as chosen: this computer only listens on loopback alone, other devices adds the chosen address', async (t) => {
  const { startSession, getPrivateAddresses } = require('../bridge/session');
  const { makeStubClaude } = require('./claude-helpers');
  const ws = makeWorkspace({ 'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>' });
  const stub = makeStubClaude(t, { authStatus: { exitCode: 0 }, prime: { result: 'Acknowledged.' } });
  const adapter = [process.execPath, path.join(__dirname, '..', 'bridge', 'adapters', 'claude-code.js'), '--cli', stub.cliString];
  t.after(() => ws.cleanup());

  const local = await startSession({ workspace: ws.dir, harness: 'claude-code', adapter, bind: { mode: 'loopback' }, pollTimeoutMs: 5000, pollIntervalMs: 50 });
  assert.deepEqual(local.server.addresses.map((a) => a.address), ['127.0.0.1']);
  assert.match(local.url, /^http:\/\/localhost:/);
  await local.server.close();

  const [address] = getPrivateAddresses();
  if (!address) return t.skip('no private network address on this machine');
  const lan = await startSession({ workspace: ws.dir, harness: 'claude-code', adapter, bind: { mode: 'network', address }, pollTimeoutMs: 5000, pollIntervalMs: 50 });
  t.after(() => lan.server.close());
  assert.deepEqual(lan.server.addresses.map((a) => a.address), ['127.0.0.1', address]);
  assert.ok(lan.url.startsWith(`http://${address}:`), lan.url);
});
