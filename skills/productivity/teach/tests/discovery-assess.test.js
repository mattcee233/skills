'use strict';
// Assessment: what the agent tells the learner about the harness's CLI (missing, stale PATH,
// lapsed login), the OS-specific steps, and recording a declined install or failed login once.
// Stub executables stand in for the real CLIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installStub, makeMachine, executableName } = require('./discovery-helpers');
const { assessCli, knownCandidates, recordDecline, recordLoginFailed, locateCli } = require('../bridge/discovery');
const { getSessionStartNotice } = require('../bridge/session');
const { readConfig } = require('../bridge/setup');
const { makeWorkspace } = require('./helpers');

const ACCOUNT = JSON.stringify({ email: 'learner@secret.corp', account_id: 'acc_secret_999' });

function runnableFolderFor(cli, machine) {
  const candidates = knownCandidates({ cli, platform: process.platform, env: machine.env, home: machine.home });
  return path.dirname(candidates.find((file) => path.basename(file) === executableName(cli)));
}

test('a CLI that is found and logged in is ready and needs no steps', (t) => {
  const machine = makeMachine(t);
  const bin = path.join(machine.root, 'bin');
  installStub(t, 'claude', bin, { authStatus: { exitCode: 0, output: ACCOUNT } });

  const result = assessCli({ harness: 'claude-code', env: machine.withPath(bin), home: machine.home });

  assert.equal(result.state, 'ready');
  assert.equal(result.usable, true);
  assert.equal(result.login, 'logged-in');
  assert.deepEqual(result.steps, []);
});

test("a missing CLI gets a one-line explanation and the install steps for the learner's OS", (t) => {
  const machine = makeMachine(t);
  const on = (platform) => assessCli({ harness: 'claude-code', platform, env: machine.env, home: machine.home });

  const win = on('win32');
  assert.equal(win.state, 'missing');
  assert.equal(win.usable, false);
  assert.match(win.line, /Claude Code is not installed/);
  assert.equal(win.line.split('\n').length, 1, 'one line');
  assert.match(win.steps.join('\n'), /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  assert.doesNotMatch(win.steps.join('\n'), /install\.sh/);

  const mac = on('darwin');
  assert.match(mac.steps.join('\n'), /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  assert.doesNotMatch(mac.steps.join('\n'), /install\.ps1/);
  assert.match(on('linux').steps.join('\n'), /install\.sh/);
  // After an install the harness may need restarting to pick up PATH, and the skill re-checks.
  assert.match(win.steps.join('\n'), /restart/i);
  assert.match(win.steps.join('\n'), /check again/i);
});

test('agy and pi have their own install steps', (t) => {
  const machine = makeMachine(t);
  const steps = (harness, platform) => assessCli({ harness, platform, env: machine.env, home: machine.home }).steps.join('\n');
  assert.match(steps('antigravity', 'win32'), /antigravity\.google\/cli\/install\.ps1/);
  assert.match(steps('antigravity', 'linux'), /antigravity\.google\/cli\/install\.sh/);
  assert.match(steps('pi', 'linux'), /npm install -g @earendil-works\/pi-coding-agent/);
  assert.match(steps('pithagoras', 'darwin'), /npm install -g @earendil-works\/pi-coding-agent/);
});

test('a CLI installed after the harness started is found in its folder, and the stale PATH is explained', (t) => {
  const machine = makeMachine(t);
  installStub(t, 'claude', runnableFolderFor('claude', machine), { authStatus: { exitCode: 0 } });

  const result = assessCli({ harness: 'claude-code', env: machine.env, home: machine.home });

  assert.equal(result.state, 'off-path');
  assert.equal(result.usable, true, 'the connector uses it from its folder');
  assert.match(result.line, /PATH/);
  assert.equal(result.line.split('\n').length, 1, 'one line');
  assert.match(result.steps.join('\n'), /restart/i);
});

test('a lapsed Claude Code login is found with claude auth status, by exit code alone', (t) => {
  const machine = makeMachine(t);
  const bin = path.join(machine.root, 'bin');
  const stub = installStub(t, 'claude', bin, { authStatus: { exitCode: 1, output: ACCOUNT } });

  const result = assessCli({ harness: 'claude-code', env: machine.withPath(bin), home: machine.home });

  assert.equal(result.state, 'not-logged-in');
  assert.equal(result.usable, false);
  assert.match(result.line, /not logged in/i);
  assert.match(result.steps.join('\n'), /claude auth login/);
  assert.doesNotMatch(JSON.stringify(result), /acc_secret|learner@secret/, 'the account details are never read');
  assert.deepEqual(stub.calls().map((call) => call.argv), [['--version'], ['auth', 'status']], 'only the free checks ran');
});

test('agy has no free login check: the login is unknown and no turn is spent', (t) => {
  const machine = makeMachine(t);
  const bin = path.join(machine.root, 'bin');
  const agy = installStub(t, 'agy', bin, {});

  const result = assessCli({ harness: 'antigravity', env: machine.withPath(bin), home: machine.home });

  assert.equal(result.state, 'ready');
  assert.equal(result.login, 'unknown');
  assert.deepEqual(agy.calls().map((call) => call.argv), [['--version']]);
});

test('discovery never installs anything or handles credentials', (t) => {
  const machine = makeMachine(t);
  assessCli({ harness: 'claude-code', env: machine.env, home: machine.home });
  assert.deepEqual(fs.readdirSync(machine.home), [], 'nothing was installed in the fake machine');
  const source = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'discovery.js'), 'utf8');
  assert.doesNotMatch(source, /auth['"`,\s]+login|setup-token|keychain|keyring/i, 'no code path handles credentials');
});

test('an unrecognised harness has no CLI to look for', (t) => {
  const machine = makeMachine(t);
  const result = assessCli({ harness: 'other', env: machine.env, home: machine.home });
  assert.equal(result.state, 'not-applicable');
  assert.equal(result.usable, false);
});

test('locateCli finds the first installed file without running it', (t) => {
  const machine = makeMachine(t);
  const bin = path.join(machine.root, 'bin');
  const stub = installStub(t, 'agy', bin, {});
  const located = locateCli({ cli: 'agy', env: machine.withPath(bin), home: machine.home });
  assert.equal(located.source, 'path');
  assert.ok(Array.isArray(located.command));
  assert.deepEqual(stub.calls(), [], 'not run');
  assert.equal(locateCli({ cli: 'agy', env: machine.env, home: machine.home }), null);
});

// ---- Declined install and failed login: recorded once ---------------------------------------

test('a declined install is recorded as declined once, and the session then stays silent', (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());

  assert.equal(recordDecline(ws.dir, { harness: 'claude-code' }).recorded, true);
  const config = readConfig(ws.dir);
  assert.equal(config.outcome.status, 'declined');
  assert.equal(config.outcome.cli, 'claude');
  const start = getSessionStartNotice(ws.dir);
  assert.equal(start.silent, true);
  assert.equal(start.canStart, false);

  const date = config.outcome.date;
  assert.equal(recordDecline(ws.dir, { harness: 'claude-code' }).recorded, false, 'recorded once');
  assert.equal(readConfig(ws.dir).outcome.date, date);
});

test("a failed login is recorded once with the adapter's hint, and the session start says one line", (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());

  assert.equal(recordLoginFailed(ws.dir, { harness: 'claude-code' }).recorded, true);
  const { outcome } = readConfig(ws.dir);
  assert.equal(outcome.status, 'login-failed');
  assert.match(outcome.hint, /claude auth login/);
  const start = getSessionStartNotice(ws.dir);
  assert.equal(start.silent, false);
  assert.equal(start.canStart, true);
  assert.match(start.notice, /claude auth login/);

  assert.equal(recordLoginFailed(ws.dir, { harness: 'claude-code' }).recorded, false, 'not recorded again');
});

test("a decline is the learner's decision: a later failed login does not overwrite it", (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  recordDecline(ws.dir, { harness: 'antigravity' });
  assert.equal(recordLoginFailed(ws.dir, { harness: 'antigravity' }).recorded, false);
  assert.equal(readConfig(ws.dir).outcome.status, 'declined');
  assert.equal(fs.readFileSync(path.join(ws.dir, '.teach', '.gitignore'), 'utf8'), '*\n');
});
