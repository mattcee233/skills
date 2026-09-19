'use strict';
// Setup and interview question for interactive /teach lessons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeWorkspace } = require('./helpers');
const {
  checkNodeVersion,
  readConfig,
  writeConfig,
  writeIgnoreFile,
  installLauncher,
  applyAgentsSignals,
  applyClaudeImport,
  setupWorkspace,
  resetInteractive,
  needsSetup,
} = require('../bridge/setup');
const { BLOCK_START, BLOCK_END } = require('../bridge/teaching-signals');

test('checkNodeVersion accepts Node 18 and newer, and rejects older or missing versions', () => {
  assert.equal(checkNodeVersion('v18.0.0').ok, true);
  assert.equal(checkNodeVersion('v18.20.4').ok, true);
  assert.equal(checkNodeVersion('v20.17.0').ok, true);
  assert.equal(checkNodeVersion('v22.9.0').ok, true);
  assert.equal(checkNodeVersion('v24.0.0').ok, true);
  assert.equal(checkNodeVersion('18.0.0').ok, true);

  assert.equal(checkNodeVersion('v16.20.0').ok, false);
  assert.equal(checkNodeVersion('v17.9.1').ok, false);
  assert.equal(checkNodeVersion('v14.17.0').ok, false);
  assert.equal(checkNodeVersion('').ok, false);
  assert.equal(checkNodeVersion(null).ok, false);
  assert.equal(checkNodeVersion(undefined).ok, true); // defaults to current process.version (>= 18)
});

test('a no to interactive mode yields no launcher, records declined in config, and creates .teach/.gitignore', () => {
  const ws = makeWorkspace({ 'MISSION.md': '# Learn Loops\n' });
  try {
    const result = setupWorkspace(ws.dir, { interactive: false });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'declined');

    // Config exists and records declined
    const config = readConfig(ws.dir);
    assert.ok(config);
    assert.equal(config.version, 1);
    assert.equal(config.outcome.status, 'declined');
    assert.ok(config.outcome.date);

    // .teach/.gitignore exists and ignores all local contents
    const gitignorePath = path.join(ws.dir, '.teach', '.gitignore');
    assert.ok(fs.existsSync(gitignorePath));
    assert.equal(fs.readFileSync(gitignorePath, 'utf8').trim(), '*');

    // Root .gitignore is NEVER touched or created
    assert.equal(fs.existsSync(path.join(ws.dir, '.gitignore')), false);

    // No launcher is installed and no signals folder created
    assert.equal(fs.existsSync(path.join(ws.dir, '.teach', 'signal.js')), false);

    // AGENTS.md and CLAUDE.md are untouched
    assert.equal(fs.existsSync(path.join(ws.dir, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(ws.dir, 'CLAUDE.md')), false);

    // Later invocations are kept silent
    assert.equal(needsSetup(ws.dir), false);
  } finally {
    ws.cleanup();
  }
});

test('a yes on Node 18+ writes config, launcher, ignore file, AGENTS.md block and CLAUDE.md import', () => {
  const ws = makeWorkspace({
    'MISSION.md': '# Learn Algorithms\n',
    'AGENTS.md': '# Instructions\n\nExisting guidelines.\n',
    'CLAUDE.md': '# Project\n',
  });
  try {
    const result = setupWorkspace(ws.dir, { interactive: true, nodeVersion: 'v20.0.0' });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'ok');

    // Config is written with status ok
    const config = readConfig(ws.dir);
    assert.ok(config);
    assert.equal(config.version, 1);
    assert.equal(config.outcome.status, 'ok');

    // Launcher signal.js is installed and executable
    const launcherPath = path.join(ws.dir, '.teach', 'signal.js');
    assert.ok(fs.existsSync(launcherPath));
    const launcherContent = fs.readFileSync(launcherPath, 'utf8');
    assert.match(launcherContent, /teach-launcher-version:/);

    // .teach/.gitignore exists
    const gitignorePath = path.join(ws.dir, '.teach', '.gitignore');
    assert.ok(fs.existsSync(gitignorePath));
    assert.equal(fs.readFileSync(gitignorePath, 'utf8').trim(), '*');

    // Root .gitignore is never created or modified
    assert.equal(fs.existsSync(path.join(ws.dir, '.gitignore')), false);

    // AGENTS.md has teaching signals block and preserves existing content
    const agentsText = fs.readFileSync(path.join(ws.dir, 'AGENTS.md'), 'utf8');
    assert.match(agentsText, /# Instructions\n\nExisting guidelines\./);
    assert.ok(agentsText.includes(BLOCK_START));
    assert.ok(agentsText.includes(BLOCK_END));

    // CLAUDE.md has @AGENTS.md import
    const claudeText = fs.readFileSync(path.join(ws.dir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeText, /# Project/);
    assert.match(claudeText, /@AGENTS\.md/);

    // Re-running does not duplicate the block or the import
    setupWorkspace(ws.dir, { interactive: true, nodeVersion: 'v20.0.0' });
    const agentsSecond = fs.readFileSync(path.join(ws.dir, 'AGENTS.md'), 'utf8');
    assert.equal(agentsSecond.indexOf(BLOCK_START), agentsSecond.lastIndexOf(BLOCK_START));

    const claudeSecond = fs.readFileSync(path.join(ws.dir, 'CLAUDE.md'), 'utf8');
    assert.equal(claudeSecond.indexOf('@AGENTS.md'), claudeSecond.lastIndexOf('@AGENTS.md'));
  } finally {
    ws.cleanup();
  }
});

test('missing or too-old Node can record no-node and fall back to plain files', () => {
  const ws = makeWorkspace({ 'MISSION.md': '# Learn Rust\n' });
  try {
    // When Node check fails and user declines / cannot install
    const result = setupWorkspace(ws.dir, {
      interactive: true,
      nodeVersion: 'v16.14.0',
      status: 'no-node',
      hint: 'Install Node 18 or later from https://nodejs.org',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no-node');

    const config = readConfig(ws.dir);
    assert.ok(config);
    assert.equal(config.outcome.status, 'no-node');
    assert.match(config.outcome.hint, /Install Node 18/);

    // Launcher is NOT installed
    assert.equal(fs.existsSync(path.join(ws.dir, '.teach', 'signal.js')), false);

    // .teach/.gitignore still exists so config is not committed
    assert.ok(fs.existsSync(path.join(ws.dir, '.teach', '.gitignore')));

    // Root .gitignore is never touched
    assert.equal(fs.existsSync(path.join(ws.dir, '.gitignore')), false);

    // Later invocations know it was recorded no-node
    assert.equal(needsSetup(ws.dir), false);
  } finally {
    ws.cleanup();
  }
});

test('a fresh clone without .teach/ triggers setup again', () => {
  const ws = makeWorkspace({
    'MISSION.md': '# Learn Python\n',
    'AGENTS.md': `${BLOCK_START}\n## Teaching signals\n...If .teach/signal.js is missing, do not signal at all.\n${BLOCK_END}\n`,
  });
  try {
    // In a fresh clone, .teach/ does not exist
    assert.equal(fs.existsSync(path.join(ws.dir, '.teach')), false);
    assert.equal(needsSetup(ws.dir), true);

    // The committed block explicitly instructs the agent not to signal
    const agentsText = fs.readFileSync(path.join(ws.dir, 'AGENTS.md'), 'utf8');
    assert.match(agentsText, /if \.teach\/signal\.js is missing/i);
  } finally {
    ws.cleanup();
  }
});

test('/teach interactive resets the outcome and re-runs setup', () => {
  const ws = makeWorkspace({ 'MISSION.md': '# Learn Go\n' });
  try {
    // Start with a declined outcome
    setupWorkspace(ws.dir, { interactive: false });
    assert.equal(readConfig(ws.dir).outcome.status, 'declined');
    assert.equal(fs.existsSync(path.join(ws.dir, '.teach', 'signal.js')), false);

    // Reset with interactive
    const resetResult = resetInteractive(ws.dir, { nodeVersion: 'v20.0.0' });
    assert.equal(resetResult.ok, true);
    assert.equal(resetResult.status, 'ok');

    // Config is reset to ok
    const config = readConfig(ws.dir);
    assert.equal(config.outcome.status, 'ok');

    // Launcher is now installed
    assert.ok(fs.existsSync(path.join(ws.dir, '.teach', 'signal.js')));

    // AGENTS.md now has the block
    assert.ok(fs.existsSync(path.join(ws.dir, 'AGENTS.md')));
    const agentsText = fs.readFileSync(path.join(ws.dir, 'AGENTS.md'), 'utf8');
    assert.ok(agentsText.includes(BLOCK_START));

    // CLAUDE.md has @AGENTS.md
    assert.ok(fs.existsSync(path.join(ws.dir, 'CLAUDE.md')));
    const claudeText = fs.readFileSync(path.join(ws.dir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeText, /@AGENTS\.md/);
  } finally {
    ws.cleanup();
  }
});

test('the learner own .gitignore is never edited even if one exists', () => {
  const ws = makeWorkspace({
    '.gitignore': 'node_modules/\n.env\n',
  });
  try {
    const originalGitignore = fs.readFileSync(path.join(ws.dir, '.gitignore'), 'utf8');

    setupWorkspace(ws.dir, { interactive: true, nodeVersion: 'v20.0.0' });

    // Root .gitignore must be byte-for-byte identical
    const currentGitignore = fs.readFileSync(path.join(ws.dir, '.gitignore'), 'utf8');
    assert.equal(currentGitignore, originalGitignore);

    // .teach/.gitignore is the only place ignored
    assert.ok(fs.existsSync(path.join(ws.dir, '.teach', '.gitignore')));
  } finally {
    ws.cleanup();
  }
});

test('CLI check-node prints version check and exits 0 on current Node', async () => {
  const { execFileSync } = require('node:child_process');
  const setupScript = path.join(__dirname, '..', 'bridge', 'setup.js');
  const out = execFileSync(process.execPath, [setupScript, 'check-node'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.major >= 18, true);
});

test('CLI setup runs setup on a workspace and outputs result JSON', async () => {
  const { execFileSync } = require('node:child_process');
  const setupScript = path.join(__dirname, '..', 'bridge', 'setup.js');
  const ws = makeWorkspace({ 'MISSION.md': '# CLI test\n' });
  try {
    const out = execFileSync(process.execPath, [setupScript, 'setup', ws.dir, '--interactive', 'yes'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status, 'ok');

    assert.ok(fs.existsSync(path.join(ws.dir, '.teach', 'config.json')));
    assert.ok(fs.existsSync(path.join(ws.dir, '.teach', 'signal.js')));
  } finally {
    ws.cleanup();
  }
});


// ---------------------------------------------------------------------------
// One writer for the recorded outcome
// ---------------------------------------------------------------------------
test('recordOutcome writes the one outcome shape, keeps the rest of the config, and keeps .teach ignored', () => {
  const { recordOutcome, readConfig, writeConfig } = require('../bridge/setup');
  const ws = makeWorkspace({});
  try {
    writeConfig(ws.dir, { version: 1, adapter: '.teach/adapters/connector.js', cli: 'my-engine', outcome: { status: 'ok', cli: 'my-engine', date: 'x', hint: null } });

    const outcome = recordOutcome(ws.dir, { status: 'declined' });
    assert.deepEqual(Object.keys(outcome).sort(), ['cli', 'date', 'hint', 'status']);
    assert.equal(outcome.status, 'declined');
    assert.equal(outcome.hint, null);
    assert.equal(outcome.cli, null);
    assert.ok(!Number.isNaN(Date.parse(outcome.date)));

    const config = readConfig(ws.dir);
    assert.equal(config.adapter, '.teach/adapters/connector.js', 'other keys are kept');
    assert.deepEqual(config.outcome, outcome);

    // A config written into a bare .teach folder is never left unignored.
    const bare = makeWorkspace({});
    try {
      recordOutcome(bare.dir, { status: 'login-failed', cli: 'claude', hint: 'Run claude auth login.' });
      assert.equal(require('node:fs').readFileSync(require('node:path').join(bare.dir, '.teach', '.gitignore'), 'utf8'), '*\n');
      assert.equal(readConfig(bare.dir).version, 1);
      assert.equal(readConfig(bare.dir).outcome.hint, 'Run claude auth login.');
    } finally {
      bare.cleanup();
    }
  } finally {
    ws.cleanup();
  }
});
