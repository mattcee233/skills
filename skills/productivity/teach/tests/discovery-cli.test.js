'use strict';
// The commands the agent runs for discovery, "check again" through the launcher's retry, and the
// guide that tells the agent about them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { installStub, makeMachine, runnableFolderFor } = require('./discovery-helpers');
const { startServer } = require('../bridge/server');
const { installLauncher } = require('../bridge/setup');
const { makeWorkspace } = require('./helpers');
const { awaitVerdict } = require('./handshake-helpers');

const TEACH = path.join(__dirname, '..');
const DISCOVERY = path.join(TEACH, 'bridge', 'discovery.js');
const CLAUDE_ADAPTER = path.join(TEACH, 'bridge', 'adapters', 'claude-code.js');

function run(file, args, { cwd = TEACH, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('assess prints the state for a harness as one JSON line', async (t) => {
  const machine = makeMachine(t);
  const result = await run(DISCOVERY, ['assess', '--harness', 'claude-code'], { env: { ...process.env, ...machine.env } });
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.state, 'missing');
  assert.match(state.steps.join('\n'), /claude\.ai\/install/);
  assert.equal(result.stdout.trim().split('\n').length, 1);
});

test('decline and login-failed record the outcome, and say when they did nothing', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const args = (command) => [command, '--workspace', ws.dir, '--harness', 'claude-code'];

  assert.equal(JSON.parse((await run(DISCOVERY, args('login-failed'))).stdout).recorded, true);
  assert.equal(JSON.parse((await run(DISCOVERY, args('login-failed'))).stdout).recorded, false);
  assert.equal(JSON.parse((await run(DISCOVERY, args('decline'))).stdout).recorded, true);
  const config = JSON.parse(fs.readFileSync(path.join(ws.dir, '.teach', 'config.json'), 'utf8'));
  assert.equal(config.outcome.status, 'declined');
});

test('a bad command or a missing workspace fails with a usage message', async () => {
  const unknown = await run(DISCOVERY, ['install', '--harness', 'claude-code']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Usage/);
  const noWorkspace = await run(DISCOVERY, ['decline', '--harness', 'claude-code']);
  assert.notEqual(noWorkspace.code, 0);
});

// "Check again": the launcher's retry re-runs the connection test, and the connector looks for the
// CLI afresh on every call, so a CLI installed since the last try is found.
async function withClaudeConnector(t) {
  const machine = makeMachine(t);
  const keys = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, machine.env);
  const ws = makeWorkspace({});
  installLauncher(ws.dir);
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' }, adapter: [process.execPath, CLAUDE_ADAPTER] });
  t.after(async () => {
    await server.close();
    ws.cleanup();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  return { machine, ws, server };
}

const launch = (ws, command) => run(path.join('.teach', 'signal.js'), [command], { cwd: ws.dir });

test('"check again" finds a CLI installed since the last try, even off a stale PATH', async (t) => {
  const { machine, ws, server } = await withClaudeConnector(t);
  const first = await awaitVerdict(server);
  assert.equal(first.state, 'static');
  assert.equal(first.reason, 'missing');
  assert.match(first.hint, /Install Claude Code/);

  installStub(t, 'claude', runnableFolderFor('claude', machine), { authStatus: { exitCode: 0 } });
  const retried = await launch(ws, 'retry');
  assert.equal(retried.code, 0, retried.stderr);

  const after = await awaitVerdict(server, (state) => state.state === 'interactive');
  assert.equal(after.state, 'interactive');
});

test('"check again" after a login is fixed reconnects', async (t) => {
  const { machine, ws, server } = await withClaudeConnector(t);
  const stub = installStub(t, 'claude', runnableFolderFor('claude', machine), { authStatus: { exitCode: 1 } });
  const first = await awaitVerdict(server);
  assert.equal(first.reason, 'not-logged-in');
  assert.match(first.hint, /claude auth login/);

  stub.setConfig({ authStatus: { exitCode: 0 } });
  await launch(ws, 'retry');

  assert.equal((await awaitVerdict(server, (state) => state.state === 'interactive')).state, 'interactive');
});

// ---- The guide ------------------------------------------------------------------------------

test('every discovery.js command and flag the guide tells the agent to run exists', () => {
  const guide = fs.readFileSync(path.join(TEACH, 'INTERACTIVE-SETUP.md'), 'utf8');
  const source = fs.readFileSync(DISCOVERY, 'utf8');
  const commands = new Set([...guide.matchAll(/discovery\.js ([a-z-]+)/g)].map((m) => m[1]));
  for (const command of ['assess', 'decline', 'login-failed']) {
    assert.ok(commands.has(command), `the guide names "${command}"`);
  }
  for (const command of commands) {
    assert.ok(source.includes(`'${command}'`), `discovery.js handles "${command}"`);
  }
  for (const [, flag] of guide.matchAll(/discovery\.js [^\n`]*?--([a-z]+)/g)) {
    assert.ok(source.includes(`flags.${flag}`), `discovery.js reads --${flag}`);
  }
  assert.match(guide, /^## Missing CLI or Lapsed Login$/m);
  assert.match(fs.readFileSync(path.join(TEACH, 'SKILL.md'), 'utf8'), /INTERACTIVE-SETUP\.md#missing-cli-or-lapsed-login/);
});

test('the guide keeps the learner in charge: no installer is run and no credentials are handled', () => {
  const guide = fs.readFileSync(path.join(TEACH, 'INTERACTIVE-SETUP.md'), 'utf8');
  const section = guide.slice(guide.indexOf('## Missing CLI or Lapsed Login'));
  assert.match(section, /never run(s)? (an|the) installer/i);
  assert.match(section, /never handle(s)? credentials/i);
  assert.match(section, /check again/i);
  assert.match(section, /retry/);
});
