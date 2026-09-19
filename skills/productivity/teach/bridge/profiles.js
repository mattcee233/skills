'use strict';
// Profile table for supported harnesses. Each entry specifies:
// - id: harness identifier
// - adapter: command array to run the adapter program
// - remote: boolean (true if remote like Pithagoras, false if local like Claude Code/Antigravity)
// - cli: CLI binary name
// - installHint: guidance to install the CLI
// - loginHint: guidance to authenticate
const path = require('node:path');

const PROFILES = {
  'claude-code': {
    id: 'claude-code',
    adapter: [process.execPath, path.join(__dirname, 'adapters', 'claude-code.js')],
    remote: false,
    cli: 'claude',
    installHint: 'Install Claude Code and make sure it is on your PATH, then press Retry.',
    loginHint: 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.',
  },
  antigravity: {
    id: 'antigravity',
    adapter: [process.execPath, path.join(__dirname, 'adapters', 'agy.js')],
    remote: false,
    cli: 'agy',
    installHint:
      'Install the Antigravity CLI (agy) and restart your application, or check the known install folder (%LOCALAPPDATA%\\agy\\bin or ~/.local/bin), then press Retry.',
    loginHint: 'Start agy and run /login, then press Retry.',
  },
  pithagoras: {
    id: 'pithagoras',
    adapter: [process.execPath, path.join(__dirname, 'adapters', 'pithagoras.js')],
    remote: true,
    cli: 'pi',
    installHint: 'Install the pi CLI and make sure it is on your PATH, then press Retry.',
    loginHint: 'Run pi and use /login, or set your provider API key, then press Retry.',
  },
};

function getProfile(id) {
  return PROFILES[id] || null;
}

module.exports = { PROFILES, getProfile };
