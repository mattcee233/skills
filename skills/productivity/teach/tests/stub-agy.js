'use strict';
// Test fixture: a scriptable stand-in for the `agy` CLI executable.
// Runs with Node:
//   node stub-agy.js <subcommand / flags>
// Records every invocation to `calls.jsonl` in its own directory and responds
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
  // 1. `agy --version`
  if (argv.includes('--version') || argv.includes('-v')) {
    const ver = config.version || {};
    if (ver.delayMs) await new Promise((r) => setTimeout(r, ver.delayMs));
    if (ver.stderr) process.stderr.write(ver.stderr);
    if (ver.exitCode !== undefined && ver.exitCode !== 0) {
      if (ver.output) process.stdout.write(ver.output);
      process.exit(ver.exitCode);
    }
    if (ver.output) process.stdout.write(ver.output);
    else process.stdout.write('1.2.7\n');
    process.exit(0);
  }

  // 2. `agy -p` turns (prime and send)
  if (argv.includes('-p')) {
    const convIdx = argv.indexOf('--conversation');
    const isSend = convIdx !== -1;
    const conversationId = isSend ? argv[convIdx + 1] : 'stub-conv-agy-123';
    const isPrime = !isSend;
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
    } else if (section.output) {
      process.stdout.write(section.output);
    } else {
      const defaultText = isPrime ? 'Acknowledged.' : 'A response from stub agy.';
      const res = {
        conversation_id: conversationId,
        status: section.status || 'SUCCESS',
        response: section.result !== undefined ? section.result : defaultText,
        duration_seconds: 0.5,
        num_turns: isPrime ? 1 : 2,
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      };
      process.stdout.write(`${JSON.stringify(res)}\n`);
    }
    process.exit(0);
  }

  // Fallback for unexpected invocations
  process.stderr.write(`Unexpected stub-agy invocation: ${JSON.stringify(argv)}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
