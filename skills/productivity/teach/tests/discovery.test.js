'use strict';
// Engine discovery: finding the harness's own CLI on PATH or in a known install folder, checking
// its login, and the install and login guidance the agent shows in chat. Stub executables stand
// in for the real CLIs, so no account, network or model turn is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installStub, makeMachine, executableName } = require('./discovery-helpers');
const { discoverCli, knownCandidates } = require('../bridge/discovery');

// The known install location this host can run a stub from (a .cmd shim on Windows).
function runnableFolderFor(cli, machine) {
  const candidates = knownCandidates({ cli, platform: process.platform, env: machine.env, home: machine.home });
  const match = candidates.find((file) => path.basename(file) === executableName(cli));
  assert.ok(match, `a known install location for ${cli} that this host can run a stub from`);
  return path.dirname(match);
}

test('a CLI on PATH is found and confirmed with --version', (t) => {
  const machine = makeMachine(t);
  const bin = path.join(machine.root, 'bin');
  installStub(t, 'claude', bin, { version: { output: '2.1.273 (Claude Code)\n' } });

  const found = discoverCli({ cli: 'claude', env: machine.withPath(bin), home: machine.home });

  assert.equal(found.found, true);
  assert.equal(found.source, 'path');
  assert.equal(found.version, '2.1.273 (Claude Code)');
  assert.ok(Array.isArray(found.command) && found.command.length >= 1);
});

test('a CLI that is only in a known install folder is found although PATH does not list it', (t) => {
  const machine = makeMachine(t);
  const folder = runnableFolderFor('claude', machine);
  installStub(t, 'claude', folder, { version: { output: '2.1.273 (Claude Code)\n' } });

  const found = discoverCli({ cli: 'claude', env: machine.env, home: machine.home });

  assert.equal(found.found, true);
  assert.equal(found.source, 'folder');
  assert.equal(found.version, '2.1.273 (Claude Code)');
});

test('the same holds for agy and pi', (t) => {
  const machine = makeMachine(t);
  const bin = path.join(machine.root, 'bin');
  installStub(t, 'agy', bin, { version: { output: '1.2.7\n' } });
  installStub(t, 'pi', bin, { version: { output: '0.85.0\n' } });
  const env = machine.withPath(bin);

  assert.equal(discoverCli({ cli: 'agy', env, home: machine.home }).version, '1.2.7');
  assert.match(discoverCli({ cli: 'pi', env, home: machine.home }).version, /^\d+\.\d+/);

  const folder = runnableFolderFor('agy', machine);
  installStub(t, 'agy', folder, { version: { output: '1.2.7\n' } });
  assert.equal(discoverCli({ cli: 'agy', env: machine.env, home: machine.home }).source, 'folder');
});

test('a CLI that is nowhere is not found', (t) => {
  const machine = makeMachine(t);
  const found = discoverCli({ cli: 'claude', env: machine.env, home: machine.home });
  assert.equal(found.found, false);
  assert.equal(found.source, null);
});

test('a file that does not run, or prints no version, is not taken for the CLI', (t) => {
  const machine = makeMachine(t);
  const bin = path.join(machine.root, 'bin');
  installStub(t, 'claude', bin, { version: { output: 'not a version\n', exitCode: 0 } });
  assert.equal(discoverCli({ cli: 'claude', env: machine.withPath(bin), home: machine.home }).found, false);

  const bin2 = path.join(machine.root, 'bin2');
  installStub(t, 'claude', bin2, { version: { output: '2.1.273\n', exitCode: 1 } });
  assert.equal(discoverCli({ cli: 'claude', env: machine.withPath(bin2), home: machine.home }).found, false);
});

test('a broken first match on PATH does not hide a working one in a known folder', (t) => {
  const machine = makeMachine(t);
  const bin = path.join(machine.root, 'bin');
  installStub(t, 'claude', bin, { version: { output: 'garbage\n', exitCode: 1 } });
  installStub(t, 'claude', runnableFolderFor('claude', machine), { version: { output: '2.1.273\n' } });

  const found = discoverCli({ cli: 'claude', env: machine.withPath(bin), home: machine.home });

  assert.equal(found.found, true);
  assert.equal(found.source, 'folder');
});

test('the known install folders cover the documented locations on every OS', (t) => {
  const machine = makeMachine(t);
  const at = (cli, platform) => knownCandidates({ cli, platform, env: machine.env, home: machine.home });
  const norm = (list) => list.map((file) => file.split(path.sep).join('/'));

  assert.ok(norm(at('claude', 'win32')).some((file) => file.endsWith('/.local/bin/claude.exe')));
  assert.ok(norm(at('agy', 'win32')).some((file) => file.endsWith('/AppData/Local/agy/bin/agy.exe')));
  assert.ok(norm(at('claude', 'linux')).some((file) => file.endsWith('/.local/bin/claude')));
  assert.ok(norm(at('agy', 'darwin')).some((file) => file.endsWith('/.local/bin/agy')));
  assert.ok(norm(at('pi', 'win32')).some((file) => file.endsWith('/AppData/Roaming/npm/pi.cmd')));
});

test('a Windows Claude Desktop stub in WindowsApps is never run as if it were the CLI', (t) => {
  const machine = makeMachine(t);
  const windowsApps = path.join(machine.root, 'Microsoft', 'WindowsApps');
  fs.mkdirSync(windowsApps, { recursive: true });
  const marker = path.join(machine.root, 'desktop-was-run');
  fs.writeFileSync(path.join(windowsApps, 'claude.exe'), '');
  const found = discoverCli({
    cli: 'claude',
    platform: 'win32',
    env: machine.withPath(windowsApps),
    home: machine.home,
    probe: () => {
      fs.writeFileSync(marker, 'run');
      return { ok: true, output: '1.0.0' };
    },
  });
  assert.equal(found.found, false);
  assert.equal(fs.existsSync(marker), false);
});
