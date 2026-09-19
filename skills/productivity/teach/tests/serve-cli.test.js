'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeWorkspace } = require('./helpers');

const SERVE = path.join(__dirname, '..', 'bridge', 'serve.js');

function run(args) {
  const child = spawn(process.execPath, [SERVE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  return {
    child,
    firstLine: () => new Promise((resolve) => child.stdout.once('data', () => resolve(stdout.split('\n')[0]))),
    exited: () => new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr }))),
  };
}

test('starts a server and prints one JSON line with the port and token, for the skill to build the URL', async (t) => {
  const ws = makeWorkspace({ 'lessons/0001-x.html': '<html><body>x</body></html>' });
  t.after(() => ws.cleanup());
  const proc = run(['--workspace', ws.dir, '--bind', 'loopback']);
  t.after(() => proc.child.kill());

  const info = JSON.parse(await proc.firstLine());
  assert.equal(typeof info.port, 'number');
  assert.match(info.token, /^[0-9a-f]{64}$/);
  assert.equal(info.pid, proc.child.pid);
  assert.deepEqual(info.addresses, [{ address: '127.0.0.1', port: info.port }]);

  const res = await fetch(`http://127.0.0.1:${info.port}/lessons/0001-x.html`);
  assert.equal(res.status, 200);
});

test('exits with an error and a message when asked to listen on every interface', async (t) => {
  const ws = makeWorkspace({});
  t.after(() => ws.cleanup());
  const proc = run(['--workspace', ws.dir, '--bind', 'network', '--address', '0.0.0.0']);
  const { code, stderr } = await proc.exited();
  assert.notEqual(code, 0);
  assert.match(stderr, /Refusing to bind/);
});

test('exits with an error when the workspace is missing or the bind mode is unknown', async () => {
  for (const args of [[], ['--workspace', 'C:/no/such/folder', '--bind', 'loopback'], ['--workspace', '.', '--bind', 'everywhere']]) {
    const { code, stderr } = await run(args).exited();
    assert.notEqual(code, 0, args.join(' '));
    assert.notEqual(stderr.trim(), '');
  }
});
