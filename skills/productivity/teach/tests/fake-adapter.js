'use strict';
// Test fixture: a scriptable stand-in for an adapter program. It follows the adapter
// contract (one JSON request on stdin, one JSON line on stdout) and answers from a
// script file, so tests can make it reply, fail, be slow, or misbehave.
//   node fake-adapter.js <script.json>
// Script keys: check, prime, send (the response to give per operation),
// delayMs ({op: ms}), writeFileOnPrime (a workspace path to create, to simulate a
// priming turn that is not read-only), progressLines (objects written before the result),
// rawOutput (written verbatim instead of the response, to test malformed output), exitCode and
// touchOnFinish (a workspace path written once the call has run to completion, so a test can
// tell a call that was killed from one that finished).
// Every call is recorded beside the script.
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = process.argv[2];
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  const request = JSON.parse(input);
  fs.appendFileSync(`${scriptPath}.calls`, `${JSON.stringify({ request, cwd: process.cwd(), env: process.env, argv: process.argv.slice(2), startedAt: Date.now() })}\n`);

  const delay = (script.delayMs || {})[request.op];
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

  if (request.op === 'prime' && script.writeFileOnPrime) {
    const target = path.join(process.cwd(), script.writeFileOnPrime);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'written during a priming turn');
  }

  for (const line of script.progressLines || []) process.stdout.write(`${JSON.stringify(line)}\n`);
  const response = script[request.op];
  if (typeof script.rawOutput === 'string') {
    process.stdout.write(script.rawOutput);
  } else {
    const missing = { type: 'result', ok: false, error: { code: 'failed', message: 'No scripted response' } };
    process.stdout.write(`${JSON.stringify(response === undefined ? missing : response)}\n`);
  }
  if (script.touchOnFinish) fs.writeFileSync(path.join(process.cwd(), script.touchOnFinish), 'finished');
  process.exitCode = script.exitCode || 0;
});
