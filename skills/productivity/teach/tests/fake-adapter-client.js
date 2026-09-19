'use strict';
// Runs the fake adapter the way the server runs a real one: workspace as the working
// directory, arguments as an array, one JSON request on stdin, one JSON line back.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ADAPTER = path.join(__dirname, 'fake-adapter.js');

async function runFakeAdapter(workspace, script, request) {
  const scriptPath = path.join(workspace.dir, '..', `${path.basename(workspace.dir)}.script.json`);
  fs.writeFileSync(scriptPath, JSON.stringify(script));
  const started = Date.now();
  const child = spawn(process.execPath, [ADAPTER, scriptPath], { cwd: workspace.dir, stdio: ['pipe', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stdin.end(JSON.stringify(request));
  await new Promise((resolve) => child.on('close', resolve));

  const calls = fs
    .readFileSync(`${scriptPath}.calls`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  fs.rmSync(scriptPath);
  fs.rmSync(`${scriptPath}.calls`);
  return {
    result: JSON.parse(output.trim()),
    elapsedMs: Date.now() - started,
    cwd: calls.at(-1).cwd,
    requests: calls.map((c) => c.request),
  };
}

// A fake adapter the server can be pointed at: the command to run it, the script it answers
// from (rewrite it with setScript between calls) and every call it has received so far.
function fakeAdapter(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-adapter-'));
  const scriptPath = path.join(dir, 'script.json');
  fs.writeFileSync(scriptPath, JSON.stringify(script));
  return {
    command: [process.execPath, ADAPTER, scriptPath],
    setScript(next) {
      fs.writeFileSync(scriptPath, JSON.stringify(next));
    },
    calls(op) {
      let text = '';
      try {
        text = fs.readFileSync(`${scriptPath}.calls`, 'utf8');
      } catch {
        return [];
      }
      const calls = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      return op ? calls.filter((c) => c.request.op === op) : calls;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { runFakeAdapter, fakeAdapter };
