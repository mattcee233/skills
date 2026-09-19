'use strict';
// A manual harness, not part of the suite: serves two sample lessons with the widget, backed
// by the fake adapter, so the widget can be tried in a real browser.
//   node tests/dev-server.js
// It prints the lesson URL (token in the fragment) and the path of the script file that
// controls the fake adapter: edit that file to make the next reply slow, an error, and so on.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../bridge/server');
const { fakeAdapter } = require('./fake-adapter-client');

const page = (n, title) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: Georgia, serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem">
<h1>${title}</h1>
<p>${'A loop repeats a step until something changes. '.repeat(12)}</p>
<p><a href="/lessons/000${n === 1 ? 2 : 1}-${n === 1 ? 'lists' : 'loops'}.html">Go to the other lesson</a></p>
</body></html>`;

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-dev-'));
  fs.mkdirSync(path.join(workspace, 'lessons'));
  fs.writeFileSync(path.join(workspace, 'lessons', '0001-loops.html'), page(1, 'Loops'));
  fs.writeFileSync(path.join(workspace, 'lessons', '0002-lists.html'), page(2, 'Lists'));

  const adapter = fakeAdapter({
    send: { type: 'result', ok: true, text: 'A loop repeats a step.\nThat is all it does.' },
    delayMs: { send: 3000 },
  });
  const server = await startServer({ workspace, bind: { mode: 'loopback' }, adapter: adapter.command, session: 'dev-session' });

  const scriptPath = adapter.command[2];
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.port}/lessons/0001-loops.html#t=${server.token}`, script: scriptPath })}\n`);

  const stop = async () => {
    await server.close();
    adapter.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
