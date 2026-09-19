'use strict';
// Test helper: installs a stub CLI on disk as a real executable the discovery code can find, and
// builds the fake home and environment it searches.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeStubClaude } = require('./claude-helpers');
const { makeStubAgy } = require('./agy-helpers');
const { makeStubPi } = require('./pi-helpers');

const MAKERS = { claude: makeStubClaude, agy: makeStubAgy, pi: makeStubPi };
const STUB_SCRIPT = { claude: 'stub-claude.js', agy: 'stub-agy.js', pi: 'stub-pi.js' };

// The file name that runs on this host: a Windows npm-style .cmd shim, or a shebang script.
function executableName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

// Puts an executable named after the CLI into `dir`; it runs the scripted stub.
function installStub(t, cli, dir, config = {}) {
  const stub = MAKERS[cli](t, config);
  const script = path.join(stub.dir, STUB_SCRIPT[cli]);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, executableName(cli));
  if (process.platform === 'win32') {
    const relative = path.relative(dir, script);
    fs.writeFileSync(file, `@ECHO off\r\n"%_prog%" "%dp0%\\${relative}" %*\r\n`);
  } else {
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(file, 0o755);
  }
  return { ...stub, file };
}

// A fake home and environment on this host, so discovery never sees the real machine's CLIs.
function makeMachine(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-machine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const emptyPath = path.join(root, 'empty-bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(emptyPath, { recursive: true });
  const env = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    PATH: emptyPath,
    Path: emptyPath,
  };
  return { root, home, env, emptyPath, withPath: (...dirs) => ({ ...env, PATH: dirs.join(path.delimiter), Path: dirs.join(path.delimiter) }) };
}

module.exports = { installStub, makeMachine, executableName };
