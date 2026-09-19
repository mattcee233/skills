'use strict';
// Test fixture: a scriptable stand-in for the `claude` CLI executable.
// Runs with Node:
//   node stub-claude.js <subcommand / flags>
// It records every invocation to `calls.jsonl` in its own directory and responds
// according to `config.json` in the same directory.
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

async function main() {
  // 1. `claude auth status`
  if (argv[0] === 'auth' && argv[1] === 'status') {
    const auth = config.authStatus || {};
    if (auth.delayMs) await new Promise((r) => setTimeout(r, auth.delayMs));
    if (auth.output) process.stdout.write(auth.output);
    if (auth.stderr) process.stderr.write(auth.stderr);
    process.exit(auth.exitCode !== undefined ? auth.exitCode : 0);
  }

  // 2. `claude --version`
  if (argv.includes('--version') || argv.includes('-v')) {
    const ver = config.version || {};
    if (ver.output) process.stdout.write(ver.output);
    else process.stdout.write('2.1.273\n');
    process.exit(ver.exitCode !== undefined ? ver.exitCode : 0);
  }

  // 3. `claude -p` turns (prime and send)
  if (argv.includes('-p')) {
    const isPrime = argv.includes('--session-id');
    const isSend = argv.includes('--resume');
    const section = isPrime ? (config.prime || {}) : (config.send || {});

    if (section.delayMs) await new Promise((r) => setTimeout(r, section.delayMs));

    if (section.exitCode !== undefined && section.exitCode !== 0) {
      if (section.stderr) process.stderr.write(section.stderr);
      if (section.output) process.stdout.write(section.output);
      process.exit(section.exitCode);
    }

    if (section.stderr) process.stderr.write(section.stderr);

    if (section.rawOutput) {
      process.stdout.write(section.rawOutput);
    } else if (section.result !== undefined) {
      process.stdout.write(`${JSON.stringify({ result: section.result, session_id: 'stub-session' })}\n`);
    } else {
      const defaultText = isPrime ? 'Acknowledged.' : 'A response from stub Claude.';
      process.stdout.write(`${JSON.stringify({ result: defaultText, session_id: 'stub-session' })}\n`);
    }
    process.exit(0);
  }

  // Fallback for unexpected invocations
  process.stderr.write(`Unexpected stub-claude invocation: ${JSON.stringify(argv)}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
