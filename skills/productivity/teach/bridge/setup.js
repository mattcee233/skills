#!/usr/bin/env node
'use strict';
// One-time setup and interactive mode management for a teaching workspace.
// Checks Node version, writes machine-local configuration (.teach/config.json),
// installs the self-ignoring .teach/.gitignore, installs the launcher (.teach/signal.js),
// and writes the teaching signals block to AGENTS.md and import line to CLAUDE.md.
//
//   node bridge/setup.js setup <workspace> [--interactive yes|no] [--status <status>]
//   node bridge/setup.js reset <workspace>
//   node bridge/setup.js check-node [--version <v>]
//   node bridge/setup.js status <workspace>

const fs = require('node:fs');
const path = require('node:path');
const { applyTeachingSignals } = require('./teaching-signals');

const CONFIG_VERSION = 1;
const LAUNCHER_SOURCE = path.join(__dirname, 'signal.js');

function checkNodeVersion(versionString) {
  const ver = versionString === undefined ? process.version : versionString;
  if (typeof ver !== 'string' || !ver) {
    return { ok: false, version: null, major: 0 };
  }
  const match = ver.trim().match(/^v?(\d+)/);
  if (!match) {
    return { ok: false, version: ver, major: 0 };
  }
  const major = parseInt(match[1], 10);
  return { ok: major >= 18, version: ver, major };
}

function teachDir(workspace) {
  return path.join(workspace, '.teach');
}

function configFile(workspace) {
  return path.join(teachDir(workspace), 'config.json');
}

function readConfig(workspace) {
  const file = configFile(workspace);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeConfig(workspace, config) {
  const dir = teachDir(workspace);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configFile(workspace), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function writeIgnoreFile(workspace) {
  const dir = teachDir(workspace);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // The learner's own root .gitignore is never edited.
  // Only the machine-local .teach/.gitignore is written.
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', 'utf8');
}

// The recorded outcome has one shape everywhere: { status, cli, date, hint }.
function makeOutcome({ status, cli = null, hint = null, date }) {
  return { status, cli, date: date || new Date().toISOString(), hint };
}

// Record the outcome in the config, keeping every other key. A config in .teach/ is always
// machine-local, so the ignore file is (re)written here too.
function recordOutcome(workspace, outcome) {
  writeIgnoreFile(workspace);
  const config = { ...(readConfig(workspace) || { version: CONFIG_VERSION }), outcome: makeOutcome(outcome) };
  writeConfig(workspace, config);
  return config.outcome;
}

function installLauncher(workspace) {
  const dir = teachDir(workspace);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const target = path.join(dir, 'signal.js');
  fs.copyFileSync(LAUNCHER_SOURCE, target);
  try {
    fs.chmodSync(target, 0o755);
  } catch {
    // Windows chmod may be a no-op
  }
}

function applyAgentsSignals(workspace) {
  const agentsPath = path.join(workspace, 'AGENTS.md');
  let existing = '';
  try {
    existing = fs.readFileSync(agentsPath, 'utf8');
  } catch {
    existing = '';
  }
  const updated = applyTeachingSignals(existing);
  fs.writeFileSync(agentsPath, updated, 'utf8');
}

function applyClaudeImport(workspace) {
  const claudePath = path.join(workspace, 'CLAUDE.md');
  let existing = '';
  let exists = false;
  try {
    existing = fs.readFileSync(claudePath, 'utf8');
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    fs.writeFileSync(claudePath, '@AGENTS.md\n', 'utf8');
    return;
  }

  if (existing.includes('@AGENTS.md')) {
    return;
  }

  const gap = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(claudePath, `${existing}${gap}@AGENTS.md\n`, 'utf8');
}

function needsSetup(workspace) {
  const config = readConfig(workspace);
  if (!config) {
    return true;
  }
  if (config.outcome && config.outcome.status) {
    return false;
  }
  return true;
}

function setupWorkspace(workspace, options = {}) {
  const interactive = options.interactive !== false && options.status !== 'declined';

  if (!interactive) {
    writeIgnoreFile(workspace);
    const config = {
      version: CONFIG_VERSION,
      adapter: null,
      cli: null,
      outcome: makeOutcome({ status: 'declined' }),
    };
    writeConfig(workspace, config);
    return { ok: true, interactive: false, status: 'declined' };
  }

  const nodeCheck = checkNodeVersion(options.nodeVersion);
  if (!nodeCheck.ok) {
    if (options.status === 'no-node') {
      writeIgnoreFile(workspace);
      const config = {
        version: CONFIG_VERSION,
        adapter: null,
        cli: null,
        outcome: makeOutcome({ status: 'no-node', hint: options.hint || 'Install Node 18 or later to use interactive mode.' }),
      };
      writeConfig(workspace, config);
      return { ok: false, reason: 'no-node', status: 'no-node' };
    }
    return { ok: false, reason: 'no-node', nodeCheck, needsInstall: true };
  }

  // Interactive yes on Node 18+
  writeIgnoreFile(workspace);
  const config = {
    version: CONFIG_VERSION,
    adapter: options.adapter || null,
    cli: options.cli || null,
    outcome: makeOutcome({ status: 'ok', cli: options.cli || null }),
  };
  writeConfig(workspace, config);
  installLauncher(workspace);
  applyAgentsSignals(workspace);
  applyClaudeImport(workspace);

  return { ok: true, interactive: true, status: 'ok' };
}

function resetInteractive(workspace, options = {}) {
  return setupWorkspace(workspace, {
    ...options,
    interactive: true,
  });
}

function parseCliArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function cliMain() {
  const args = parseCliArgs(process.argv.slice(2));
  const command = args._[0];

  if (command === 'check-node') {
    const res = checkNodeVersion(args.version);
    process.stdout.write(`${JSON.stringify(res)}\n`);
    process.exit(res.ok ? 0 : 1);
  }

  if (command === 'setup') {
    const ws = args._[1] || '.';
    const interactive = args.declined ? false : args.interactive === 'no' ? false : true;
    const res = setupWorkspace(ws, {
      interactive,
      status: args.status || (args.declined ? 'declined' : undefined),
      adapter: args.adapter,
      cli: args.cli,
      hint: args.hint,
      nodeVersion: args['node-version'],
    });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    process.exit(res.ok ? 0 : 1);
  }

  if (command === 'reset') {
    const ws = args._[1] || '.';
    const res = resetInteractive(ws, {
      adapter: args.adapter,
      cli: args.cli,
      nodeVersion: args['node-version'],
    });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    process.exit(res.ok ? 0 : 1);
  }

  if (command === 'status') {
    const ws = args._[1] || '.';
    const cfg = readConfig(ws);
    process.stdout.write(`${JSON.stringify({ needsSetup: needsSetup(ws), config: cfg })}\n`);
    process.exit(0);
  }

  process.stderr.write('Usage: node setup.js [setup|reset|check-node|status]\n');
  process.exit(1);
}

if (require.main === module) {
  cliMain();
}

module.exports = {
  checkNodeVersion,
  teachDir,
  configFile,
  readConfig,
  writeConfig,
  writeIgnoreFile,
  recordOutcome,
  installLauncher,
  applyAgentsSignals,
  applyClaudeImport,
  setupWorkspace,
  resetInteractive,
  needsSetup,
  CONFIG_VERSION,
};
