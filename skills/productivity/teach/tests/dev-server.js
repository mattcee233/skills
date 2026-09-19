'use strict';
// A manual harness, not part of the suite: serves two sample lessons with the widget, backed
// by the fake adapter, so the widget can be tried in a real browser.
//   node tests/dev-server.js
// It prints the lesson URL (token in the fragment) and the path of the script file that
// controls the fake adapter: edit that file to make the next reply slow, an error, and so on.
// The handshake runs at start: the fake adapter's check is slow and fails at first ("not
// logged in"), so the page goes Connecting..., then Chat not connected. Change "check" in the
// script to {"type":"result","ok":true,"permissions":"..."} and press Retry to see live chat.
// The launcher is installed in the workspace, and the workspace path is printed, so signals can be
// tried from another terminal (run from that folder):
//   node .teach/signal.js next-lesson lessons/0002-lists.html "Lists"
//   node .teach/signal.js reload lessons/0001-loops.html
//   node tests/dev-server.js connected   starts with a session already given (no handshake), with a
//                                        permission text so the notice shows
//   node tests/dev-server.js connected improvised   the same, marked as an AI-written connector
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
<p><label>Try it: <input id="answer" placeholder="type here, then send a reload"></label></p>
<p><a href="/lessons/000${n === 1 ? 2 : 1}-${n === 1 ? 'lists' : 'loops'}.html">Go to the other lesson</a></p>
</body></html>`;

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-dev-'));
  fs.mkdirSync(path.join(workspace, 'lessons'));
  fs.writeFileSync(path.join(workspace, 'lessons', '0001-loops.html'), page(1, 'Loops'));
  fs.writeFileSync(path.join(workspace, 'lessons', '0002-lists.html'), page(2, 'Lists'));

  fs.mkdirSync(path.join(workspace, '.teach'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'bridge', 'signal.js'), path.join(workspace, '.teach', 'signal.js'));

  const adapter = fakeAdapter({
    check: { type: 'result', ok: false, error: { code: 'not-logged-in', message: 'Not logged in.', hint: 'Run claude auth login in a terminal, then press Retry.' } },
    prime: { type: 'result', ok: true, session: 'dev-session' },
    send: { type: 'result', ok: true, text: 'A loop repeats a step.\nThat is all it does.' },
    delayMs: { check: 1500, send: 3000 },
  });
  const session = process.argv[2] === 'connected' ? 'dev-session' : null;
  const permissions = session ? 'Read and edit files in this workspace, browse the web for research, and run only the signalling command.' : undefined;
  const server = await startServer({ workspace, bind: { mode: 'loopback' }, adapter: adapter.command, session, permissions, improvised: process.argv[3] === 'improvised' });

  const scriptPath = adapter.command[2];
  process.stdout.write(`${JSON.stringify({ workspace, url: `http://127.0.0.1:${server.port}/lessons/0001-loops.html#t=${server.token}`, script: scriptPath })}\n`);

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
