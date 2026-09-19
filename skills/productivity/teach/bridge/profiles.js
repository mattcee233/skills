'use strict';
// Profile table for supported harnesses. Each entry specifies:
// - id: harness identifier
// - adapter: command array to run the adapter program
// - remote: boolean (true if remote like Pithagoras, false if local like pi, Claude Code and Antigravity)
// - cli: CLI binary name
// - label: what the engine's CLI is called at the start of a sentence
// - installHint: guidance to install the CLI
// - loginHint: guidance to authenticate
// - install: the official install steps per OS (win32, darwin, linux), shown in chat for the
//   learner to run; the skill never runs an installer
// - loginSteps: the steps to log in, run by the learner; the skill never handles credentials
const path = require('node:path');

const PI_INSTALL = ['Open a terminal and run: npm install -g @earendil-works/pi-coding-agent'];
const PI_LOGIN = ['Run pi and use /login, or set your provider API key.'];

const PROFILES = {
  'claude-code': {
    id: 'claude-code',
    adapter: [process.execPath, path.join(__dirname, 'adapters', 'claude-code.js')],
    remote: false,
    cli: 'claude',
    label: 'Claude Code',
    install: {
      win32: ['Open PowerShell and run: irm https://claude.ai/install.ps1 | iex'],
      darwin: ['Open Terminal and run: curl -fsSL https://claude.ai/install.sh | bash'],
      linux: ['Open a terminal and run: curl -fsSL https://claude.ai/install.sh | bash'],
    },
    loginSteps: ['Run "claude auth login" in your terminal, or type /login inside Claude Code.'],
    installHint: 'Install Claude Code and make sure it is on your PATH, then press Retry.',
    loginHint: 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.',
  },
  antigravity: {
    id: 'antigravity',
    adapter: [process.execPath, path.join(__dirname, 'adapters', 'agy.js')],
    remote: false,
    cli: 'agy',
    label: 'The Antigravity CLI (agy)',
    install: {
      win32: ['Open PowerShell and run: irm https://antigravity.google/cli/install.ps1 | iex'],
      darwin: ['Open Terminal and run: curl -fsSL https://antigravity.google/cli/install.sh | bash'],
      linux: ['Open a terminal and run: curl -fsSL https://antigravity.google/cli/install.sh | bash'],
    },
    loginSteps: ['Start agy and run /login.'],
    installHint:
      'Install the Antigravity CLI (agy) and restart your application, or check the known install folder (%LOCALAPPDATA%\\agy\\bin or ~/.local/bin), then press Retry.',
    loginHint: 'Start agy and run /login, then press Retry.',
  },
  // Plain pi and Pithagoras share one adapter (the pi CLI). They differ in where the learner sits:
  // pi runs beside the learner, Pithagoras is driven from elsewhere (Telegram, say), so its
  // server must be reachable over the network.
  pi: {
    id: 'pi',
    adapter: [process.execPath, path.join(__dirname, 'adapters', 'pi.js')],
    remote: false,
    cli: 'pi',
    label: 'The pi CLI',
    install: { win32: PI_INSTALL, darwin: PI_INSTALL, linux: PI_INSTALL },
    loginSteps: PI_LOGIN,
    installHint: 'Install the pi CLI and make sure it is on your PATH, then press Retry.',
    loginHint: 'Run pi and use /login, or set your provider API key, then press Retry.',
  },
  pithagoras: {
    id: 'pithagoras',
    adapter: [process.execPath, path.join(__dirname, 'adapters', 'pi.js')],
    remote: true,
    cli: 'pi',
    label: 'The pi CLI',
    install: { win32: PI_INSTALL, darwin: PI_INSTALL, linux: PI_INSTALL },
    loginSteps: PI_LOGIN,
    installHint: 'Install the pi CLI and make sure it is on your PATH, then press Retry.',
    loginHint: 'Run pi and use /login, or set your provider API key, then press Retry.',
  },
};

function getProfile(id) {
  return PROFILES[id] || null;
}

module.exports = { PROFILES, getProfile };
