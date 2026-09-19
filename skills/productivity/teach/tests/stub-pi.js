'use strict';
// Test fixture: a scriptable stand-in for the `pi` CLI executable, modelled on the real
// pi 0.85 behaviour (`pi list`, and `pi -p --mode json` emitting one JSON event per line).
//   node stub-pi.js <subcommand / flags>
// It records every invocation to `calls.jsonl` in its own directory and responds
// according to `config.json` in the same directory:
//   list:  { packages: [...names], exitCode, stderr, delayMs }
//   prime / send: { text, stopReason, errorMessage, exitCode, stderr, delayMs, rawOutput }
//     (the first `-p` call uses `prime`, later ones use `send`)
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(__dirname, 'config.json');
const callsPath = path.join(__dirname, 'calls.jsonl');

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  config = {};
}

const argv = process.argv.slice(2);
fs.appendFileSync(callsPath, `${JSON.stringify({ argv, cwd: process.cwd(), startedAt: Date.now() })}\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emitTurn(section, sessionId) {
  const assistant = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Working it out.' },
      { type: 'text', text: section.text },
    ],
    stopReason: section.stopReason || 'stop',
  };
  if (section.errorMessage) assistant.errorMessage = section.errorMessage;
  const events = [
    { type: 'session', version: 3, id: sessionId, cwd: process.cwd() },
    { type: 'agent_start' },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message_end', message: assistant },
    { type: 'agent_end', messages: [{ role: 'user', content: [] }, assistant] },
    { type: 'agent_settled' },
  ];
  process.stdout.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

async function main() {
  // `pi list`: the installed packages, one per line.
  if (argv[0] === 'list') {
    const list = config.list || {};
    if (list.delayMs) await sleep(list.delayMs);
    if (list.stderr) process.stderr.write(list.stderr);
    if (list.exitCode) process.exit(list.exitCode);
    const packages = list.packages || ['npm:pi-web-access'];
    process.stdout.write(`User packages:\n${packages.map((p) => `  ${p}\n    C:\\pkgs\\${p}\n`).join('')}`);
    process.exit(0);
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write('0.85.1\n');
    process.exit(0);
  }

  // A turn: `pi -p --mode json --session-id <id> --append-system-prompt <text> -- <message>`
  if (argv.includes('-p')) {
    const dashIdx = argv.indexOf('--');
    const message = dashIdx === -1 ? '' : argv.slice(dashIdx + 1).join(' ');

    // Real pi reads a leading @ as a file to attach, and prints an error but exits 0.
    if (message.startsWith('@')) {
      process.stderr.write(`Error: File not found: ${message}\n`);
      process.exit(0);
    }

    let priorTurns = 0;
    try {
      for (const line of fs.readFileSync(callsPath, 'utf8').trim().split('\n')) {
        if (line && JSON.parse(line).argv.includes('-p')) priorTurns++;
      }
    } catch {}
    const first = priorTurns <= 1;
    const section = (first ? config.prime || config.send : config.send || config.prime) || {};

    const sessionIdx = argv.indexOf('--session-id');
    const sessionId = sessionIdx !== -1 ? argv[sessionIdx + 1] : 'stub-session-pi-123';

    if (section.delayMs) await sleep(section.delayMs);
    if (section.stderr) process.stderr.write(section.stderr);
    if (section.exitCode) process.exit(section.exitCode);
    if (section.rawOutput !== undefined) {
      process.stdout.write(section.rawOutput);
      process.exit(0);
    }
    emitTurn({ ...section, text: section.text !== undefined ? section.text : first ? 'Acknowledged.' : 'A response from stub pi.' }, sessionId);
    process.exit(0);
  }

  process.stderr.write(`Unexpected stub-pi invocation: ${JSON.stringify(argv)}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
