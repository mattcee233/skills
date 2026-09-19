'use strict';
// The commands an agent runs to work with improvised adapters (find a kept one, record a
// refusal, scaffold a new one), and the guide that points the agent at them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeWorkspace } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bridge', 'improvised.js');
const GUIDE = path.join(__dirname, '..', 'IMPROVISED-ADAPTERS.md');

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

function scaffold(ws, extra = []) {
  return run([
    'scaffold',
    '--workspace', ws.dir,
    '--engine-cli', JSON.stringify(['my-engine', '--quiet']),
    '--permissions', 'Reads and edits files in this workspace only.',
    ...extra,
  ]);
}

test('find reports nothing when no connector has been kept', () => {
  const ws = makeWorkspace({});
  try {
    const result = run(['find', '--workspace', ws.dir]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.out), { found: false });
  } finally {
    ws.cleanup();
  }
});

test('scaffold writes one adapter under .teach/adapters and find then returns the command to run it', () => {
  const ws = makeWorkspace({ 'MISSION.md': 'Learn Python.' });
  try {
    const made = scaffold(ws);
    assert.equal(made.code, 0, made.err);
    const written = JSON.parse(made.out);
    const expected = path.join(ws.dir, '.teach', 'adapters', 'connector.js');
    assert.equal(path.resolve(written.written), path.resolve(expected));

    // The file is valid JavaScript and carries what was asked for.
    const source = fs.readFileSync(expected, 'utf8');
    assert.equal(spawnSync(process.execPath, ['--check', expected]).status, 0);
    assert.ok(source.includes('"my-engine"'));
    assert.ok(source.includes('Reads and edits files in this workspace only.'));

    // Nothing else in the workspace changed.
    assert.equal(fs.readFileSync(path.join(ws.dir, 'MISSION.md'), 'utf8'), 'Learn Python.');
    assert.deepEqual(fs.readdirSync(path.join(ws.dir, '.teach', 'adapters')), ['connector.js']);

    const found = JSON.parse(run(['find', '--workspace', ws.dir]).out);
    assert.equal(found.found, true);
    assert.equal(path.resolve(found.adapter), path.resolve(expected));
    assert.deepEqual(found.command, [process.execPath, found.adapter]);
  } finally {
    ws.cleanup();
  }
});

test('scaffold never rewrites a kept adapter', () => {
  const ws = makeWorkspace({});
  try {
    assert.equal(scaffold(ws).code, 0);
    const file = path.join(ws.dir, '.teach', 'adapters', 'connector.js');
    fs.appendFileSync(file, '// the learner edited this\n');
    const before = fs.readFileSync(file, 'utf8');

    const again = scaffold(ws);
    assert.notEqual(again.code, 0);
    assert.match(again.err, /already exists/);
    assert.match(again.err, /\/teach interactive/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    ws.cleanup();
  }
});

test('scaffold refuses a name that would leave the adapters folder, and bad input', () => {
  const ws = makeWorkspace({});
  try {
    for (const name of ['../evil', 'a/b', 'a b', '.hidden', '']) {
      const result = scaffold(ws, ['--name', name]);
      assert.notEqual(result.code, 0, `name "${name}" is refused`);
    }
    assert.equal(fs.existsSync(path.join(ws.dir, 'evil.js')), false);
    assert.equal(fs.existsSync(path.join(ws.dir, '.teach', 'evil.js')), false);

    const notAnArray = run(['scaffold', '--workspace', ws.dir, '--engine-cli', 'my-engine', '--permissions', 'x']);
    assert.notEqual(notAnArray.code, 0);
    assert.match(notAnArray.err, /JSON array/);

    const noPermissions = run(['scaffold', '--workspace', ws.dir, '--engine-cli', '["e"]']);
    assert.notEqual(noPermissions.code, 0);
    assert.match(noPermissions.err, /--permissions/);

    assert.equal(fs.existsSync(path.join(ws.dir, '.teach', 'adapters')), false, 'nothing was created');
  } finally {
    ws.cleanup();
  }
});

test('decline records declined, after which a session start is silent and starts nothing', () => {
  const { getSessionStartNotice } = require('../bridge/session');
  const ws = makeWorkspace({});
  try {
    const result = run(['decline', '--workspace', ws.dir]);
    assert.equal(result.code, 0, result.err);
    assert.equal(JSON.parse(result.out).recorded, 'declined');

    const notice = getSessionStartNotice(ws.dir);
    assert.equal(notice.silent, true);
    assert.equal(notice.canStart, false);
    assert.equal(fs.existsSync(path.join(ws.dir, '.teach', 'adapters')), false, 'no adapter written');
    assert.equal(fs.readFileSync(path.join(ws.dir, '.teach', '.gitignore'), 'utf8'), '*\n', 'the machine-local config is ignored');
  } finally {
    ws.cleanup();
  }
});

test('unknown commands and a missing workspace are refused with a usage line', () => {
  const unknown = run(['wander', '--workspace', '.']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /Usage/);

  const missing = run(['find', '--workspace', path.join(__dirname, 'no-such-folder')]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /existing folder/);
});

test('the guide points the agent at every improvised.js command, and at session.js to start', () => {
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const source = fs.readFileSync(CLI, 'utf8');

  const commands = new Set([...guide.matchAll(/improvised\.js ([a-z]+)/g)].map((m) => m[1]));
  for (const command of ['find', 'decline', 'scaffold']) {
    assert.ok(commands.has(command), `the guide names "${command}"`);
  }
  for (const command of commands) {
    assert.ok(source.includes(`command === '${command}'`), `improvised.js handles "${command}"`);
  }

  const flags = [...guide.matchAll(/improvised\.js [^\n`]*?--([a-z-]+)/g)].map((m) => m[1]);
  for (const flag of new Set(flags)) {
    const key = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    assert.ok(source.includes(`flags['${flag}']`) || source.includes(`flags.${key}`) || source.includes(`flags.${flag}`), `improvised.js reads --${flag}`);
  }

  assert.match(guide, /session\.js start/);
  assert.doesNotMatch(guide, /serve\.js/, 'the guide starts the server through session.js');
});
