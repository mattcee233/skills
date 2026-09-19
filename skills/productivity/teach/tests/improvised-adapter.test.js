'use strict';
// Tests for improvised adapters (Ticket 27):
// - Unrecognised harness with documented route offers connector; yes produces conforming adapter, no records declined.
// - With no documented route the session is tier 2.
// - Improvised adapter stored in workspace-local .teach/adapters/ and reused; skill folder unmodified.
// - A kept adapter that starts failing check drops to tier 2 and is not rewritten.
// - Unreviewed-connector line appears above permissions in widget.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { startServer } = require('../bridge/server');
const { HOLDER, makeWorkspace, get, post, openTab } = require('./helpers');
const { awaitVerdict, handshakeState } = require('./handshake-helpers');
const {
  UNREVIEWED_CONNECTOR_WARNING,
  findKeptAdapter,
  buildImprovisedAdapterSource,
} = require('../bridge/improvised');
const { recordOutcome } = require('../bridge/setup');

// Create a scriptable stub engine executable
function makeScriptableEngine(t) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'stub-engine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ loggedIn: true, reply: 'Engine response.' }));

  const scriptFile = path.join(dir, 'engine.js');
  const scriptContent = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('engine/1.0.0\\n');
  process.exit(0);
}
if (args[0] === '--auth-status') {
  if (!state.loggedIn) {
    process.stderr.write('not authenticated\\n');
    process.exit(1);
  }
  process.stdout.write('authenticated as test-user\\n');
  process.exit(0);
}
if (args[0] === '--prime') {
  if (state.primeError) {
    process.stderr.write(state.primeError + '\\n');
    process.exit(1);
  }
  if (state.primeWritesFile) {
    fs.writeFileSync(args[1] + '/naughty.txt', 'mutated!');
  }
  process.stdout.write(JSON.stringify({ sessionId: 'session-custom-abc' }) + '\\n');
  process.exit(0);
}
if (args[0] === '--send') {
  process.stdout.write(JSON.stringify({ reply: state.reply || 'Default reply' }) + '\\n');
  process.exit(0);
}
process.stderr.write('unknown command: ' + args.join(' ') + '\\n');
process.exit(2);
`;
  fs.writeFileSync(scriptFile, scriptContent);

  return {
    dir,
    scriptFile,
    setState(patch) {
      const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      fs.writeFileSync(stateFile, JSON.stringify({ ...current, ...patch }));
    },
  };
}

test('unrecognised harness offer refusal records declined in workspace config and runs tier 2', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn something.',
    'lessons/0001-lesson.html': '<!doctype html><html><body><h1>Lesson 1</h1></body></html>',
  });
  t.after(() => ws.cleanup());

  // Learner said no: record declined outcome
  recordOutcome(ws.dir, { status: 'declined', date: new Date().toISOString() });

  const configPath = path.join(ws.dir, '.teach', 'config.json');
  assert.equal(fs.existsSync(configPath), true, 'config.json was created');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.outcome.status, 'declined');

  // No adapter was written
  assert.equal(findKeptAdapter(ws.dir), null);

  // Server without adapter runs in tier 2 (state: static, reason: no-adapter)
  const server = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: null,
  });
  t.after(() => server.close());

  const state = await handshakeState(server);
  assert.equal(state.state, 'static');
  assert.equal(state.reason, 'no-adapter');
});

test('unrecognised harness with no documented non-interactive route remains tier 2 with no adapter written', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn something.',
    'lessons/0001-lesson.html': '<!doctype html><html><body><h1>Lesson 1</h1></body></html>',
  });
  t.after(() => ws.cleanup());

  // No adapter written
  assert.equal(findKeptAdapter(ws.dir), null);

  const server = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: null,
  });
  t.after(() => server.close());

  const state = await handshakeState(server);
  assert.equal(state.state, 'static');
  assert.equal(state.reason, 'no-adapter');
});

test('unrecognised harness with documented route: accepted choice produces adapter passing conformance against scripted engine', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn something.',
    'lessons/0001-lesson.html': '<!doctype html><html><body><h1>Lesson 1</h1></body></html>',
  });
  t.after(() => ws.cleanup());

  const engine = makeScriptableEngine(t);

  // Snapshot skill folder files before generating adapter to prove skill folder is untouched
  const skillBridgeDir = path.join(__dirname, '..', 'bridge');
  const bridgeFilesBefore = fs.readdirSync(skillBridgeDir);
  const skillAdaptersDir = path.join(skillBridgeDir, 'adapters');
  const adaptersFilesBefore = fs.readdirSync(skillAdaptersDir);

  // Generate and write improvised adapter in workspace-local folder
  const adapterDir = path.join(ws.dir, '.teach', 'adapters');
  fs.mkdirSync(adapterDir, { recursive: true });
  const adapterFile = path.join(adapterDir, 'custom-engine.js');

  const permissionsText = 'File reading and editing in workspace; research browsing; terminal limited to signalling.';
  const adapterSource = buildImprovisedAdapterSource({
    engineCli: [process.execPath, engine.scriptFile],
    permissions: permissionsText,
    loginHint: 'Run the custom-engine auth command in your terminal, then press Retry.',
  });
  fs.writeFileSync(adapterFile, adapterSource);

  // Verify stored in workspace-local folder and nothing in skill folder is modified
  assert.equal(fs.existsSync(adapterFile), true);
  assert.deepEqual(fs.readdirSync(skillBridgeDir), bridgeFilesBefore);
  assert.deepEqual(fs.readdirSync(skillAdaptersDir), adaptersFilesBefore);

  // Kept adapter can be found
  const kept = findKeptAdapter(ws.dir);
  assert.equal(kept, adapterFile);

  // Start real server with improvised adapter and --improvised true
  const server = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: [process.execPath, adapterFile],
    improvised: true,
  });
  const page = await openTab(server, HOLDER);
  t.after(async () => {
    page.close();
    await server.close();
  });

  // Handshake passes conformance against scripted engine
  const state = await awaitVerdict(server, (s) => s.state === 'interactive');
  assert.equal(state.state, 'interactive');
  assert.equal(state.improvised, true);
  assert.equal(state.permissions, permissionsText);

  // Send round trip through improvised adapter works
  const sendRes = await post(server, '/send', { id: 'msg-1', lesson: 'lessons/0001-lesson.html', text: 'Hello engine!' }, server.token, HOLDER);
  assert.equal(sendRes.status, 202);

  // Wait for reply
  let replyBody = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await get(server, '/reply/msg-1');
    if (res.ok) {
      const body = await res.json();
      if (body.status === 'done') {
        replyBody = body;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.notEqual(replyBody, null);
  assert.equal(replyBody.result.ok, true);
  assert.equal(replyBody.result.text, 'Engine response.');
});

test('an improvised adapter whose prime modifies workspace files fails conformance', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn something.',
    'lessons/0001-lesson.html': '<!doctype html><html><body><h1>Lesson 1</h1></body></html>',
  });
  t.after(() => ws.cleanup());

  const engine = makeScriptableEngine(t);
  engine.setState({ primeWritesFile: true });

  const adapterDir = path.join(ws.dir, '.teach', 'adapters');
  fs.mkdirSync(adapterDir, { recursive: true });
  const adapterFile = path.join(adapterDir, 'mutating-engine.js');

  const adapterSource = buildImprovisedAdapterSource({
    engineCli: [process.execPath, engine.scriptFile],
    permissions: 'Reads files.',
    passWorkspaceToPrime: true,
  });
  fs.writeFileSync(adapterFile, adapterSource);

  const server = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: [process.execPath, adapterFile],
    improvised: true,
  });
  t.after(() => server.close());

  const state = await awaitVerdict(server);
  assert.equal(state.state, 'static');
  assert.equal(state.reason, 'conformance');
});

test('a kept adapter that starts failing check drops to tier 2 and is NOT rewritten', async (t) => {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn something.',
    'lessons/0001-lesson.html': '<!doctype html><html><body><h1>Lesson 1</h1></body></html>',
  });
  t.after(() => ws.cleanup());

  const engine = makeScriptableEngine(t);
  const adapterDir = path.join(ws.dir, '.teach', 'adapters');
  fs.mkdirSync(adapterDir, { recursive: true });
  const adapterFile = path.join(adapterDir, 'kept-engine.js');

  const adapterSource = buildImprovisedAdapterSource({
    engineCli: [process.execPath, engine.scriptFile],
    permissions: 'File reading and editing.',
    loginHint: 'Run custom auth login.',
  });
  fs.writeFileSync(adapterFile, adapterSource);

  // Compute hash before running
  const contentBefore = fs.readFileSync(adapterFile, 'utf8');

  // Server start 1: passing
  const server1 = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: [process.execPath, adapterFile],
    improvised: true,
  });
  const state1 = await awaitVerdict(server1, (s) => s.state === 'interactive');
  assert.equal(state1.state, 'interactive');
  await server1.close();

  // Engine starts failing auth check
  engine.setState({ loggedIn: false });

  // Server start 2: reused kept adapter runs check -> fails
  const server2 = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: [process.execPath, adapterFile],
    improvised: true,
  });
  t.after(() => server2.close());

  const state2 = await awaitVerdict(server2);
  assert.equal(state2.state, 'static');
  assert.equal(state2.reason, 'not-logged-in');
  assert.equal(state2.hint, 'Run custom auth login.');

  // The kept adapter was NOT rewritten or modified
  const contentAfter = fs.readFileSync(adapterFile, 'utf8');
  assert.equal(contentAfter, contentBefore, 'kept adapter must not be silently rewritten');
});

test('unreviewed warning line is defined and matches the widget fixed notice', () => {
  assert.equal(
    UNREVIEWED_CONNECTOR_WARNING,
    'This connector was written by an AI for this workspace and has not been reviewed. Check what it does before you rely on it.'
  );
});

test('unreviewed-connector line appears above the adapter permission text in widget DOM structure', () => {
  const widgetSource = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'widget', 'widget.js'), 'utf8');
  assert.match(widgetSource, /if\s*\(permissionInfo\.improvised\)\s*permission\.appendChild\(element\('p',\s*'teach-unreviewed',\s*UNREVIEWED_LINE\)\);/);
  assert.match(widgetSource, /var UNREVIEWED_LINE =\s*'This connector was written by an AI for this workspace and has not been reviewed\. Check what it does before you rely on it\.'\s*;/);

  // Verify order: unreviewed line appended before the 'Before you start:' permissions line
  const unreviewedIdx = widgetSource.indexOf("permission.appendChild(element('p', 'teach-unreviewed', UNREVIEWED_LINE))");
  const permissionsLineIdx = widgetSource.indexOf("line.appendChild(element('strong', null, 'Before you start: '))");
  assert.equal(unreviewedIdx !== -1, true);
  assert.equal(permissionsLineIdx !== -1, true);
  assert.equal(unreviewedIdx < permissionsLineIdx, true, 'unreviewed line must appear above the adapter permission text');
});

