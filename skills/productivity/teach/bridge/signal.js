#!/usr/bin/env node
// teach-launcher-version: 1
'use strict';
// The launcher an agent runs to tell an open lesson page that something changed. Setup copies this
// file into the workspace as .teach/signal.js, so it stands alone: Node built-ins only, no requires
// from the skill. It holds no secret. The port and the per-session token are read from the server's
// pid and port file (.teach/server.json) and the token is never an argument.
//
//   node .teach/signal.js next-lesson <lesson> "<title>"
//   node .teach/signal.js reload <lesson>
//   node .teach/signal.js status
//   node .teach/signal.js retry
//
// <lesson> is a path from the workspace root, like lessons/0002-recursion.html. When the server
// cannot be reached, a signal is left as a file in .teach/signals/ for the server to pick up.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const TEACH_DIR = __dirname;
const WORKSPACE = path.dirname(TEACH_DIR);
const STATE_FILE = path.join(TEACH_DIR, 'server.json');
const SIGNALS_DIR = path.join(TEACH_DIR, 'signals');
const REQUEST_TIMEOUT_MS = 5000;
const MAX_TITLE_LENGTH = 200;

const USAGE = [
  'Usage:',
  '  node .teach/signal.js next-lesson <lesson> "<title>"',
  '  node .teach/signal.js reload <lesson>',
  '  node .teach/signal.js status',
  '  node .teach/signal.js retry',
  '<lesson> is a path from the workspace root, like lessons/0002-recursion.html.',
].join('\n');

class Refusal extends Error {}

// The same checks the server applies: a known event, a title for a next lesson, and a lesson that
// exists inside the workspace's lessons folder. Returns the signal to send.
function checkSignal(event, lessonArg, title) {
  if (event !== 'next-lesson' && event !== 'reload') throw new Refusal('The event must be "next-lesson" or "reload".');
  if (!lessonArg) throw new Refusal('A lesson path is required, such as "lessons/0002-recursion.html".');
  const lesson = lessonArg.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  const segments = lesson.split('/');
  const isLesson =
    !lesson.includes('\0') &&
    segments.length >= 2 &&
    segments[0] === 'lessons' &&
    segments.every((s) => s !== '' && s !== '.' && s !== '..') &&
    /\.html?$/i.test(lesson);
  let found = false;
  if (isLesson) {
    try {
      const root = fs.realpathSync(path.join(WORKSPACE, 'lessons'));
      const file = fs.realpathSync(path.join(WORKSPACE, ...segments));
      found = file.startsWith(root + path.sep) && fs.statSync(file).isFile();
    } catch {
      found = false;
    }
  }
  if (!found) throw new Refusal(`"${lessonArg}" is not an existing lesson in the workspace's lessons folder.`);

  if (event === 'reload') return { event, lesson };
  if (typeof title !== 'string' || !title.trim()) throw new Refusal('A next-lesson signal needs a title for the button.');
  if (title.length > MAX_TITLE_LENGTH || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new Refusal(`The title must be plain text of up to ${MAX_TITLE_LENGTH} characters, on one line.`);
  }
  return { event, lesson, title: title.trim() };
}

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const usable = Number.isInteger(state.port) && state.port > 0 && typeof state.token === 'string';
    return usable ? state : null;
  } catch {
    return null;
  }
}

// Ask the server on the loopback address. Resolves to { status, body }, or to null when nothing
// answers (no state file, connection refused, a timeout): the caller decides what "unreachable" means.
function ask(method, route, payload) {
  const state = readState();
  if (!state) return Promise.resolve(null);
  return new Promise((resolve) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const headers = { 'X-Teach-Token': state.token };
    if (data !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port: state.port, path: route, method, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode, body });
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    if (data !== null) req.write(data);
    req.end();
  });
}

// Leave the signal where the server's poll will find it. Written under another name and renamed, so
// the server never reads half a file.
function dropFile(signal) {
  fs.mkdirSync(SIGNALS_DIR, { recursive: true });
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const partial = path.join(SIGNALS_DIR, `${name}.tmp`);
  fs.writeFileSync(partial, JSON.stringify(signal));
  fs.renameSync(partial, path.join(SIGNALS_DIR, `${name}.json`));
}

const NOT_RUNNING = 'The teaching server is not running or cannot be reached. Run /teach to start it.';

function refusedBy(reply) {
  if (reply.status === 401) return 'The teaching server refused the token in .teach/server.json. Run /teach to restart the session.';
  if (reply.status === 403) return 'The teaching server only takes requests made on its own computer.';
  return (reply.body && reply.body.message) || `The teaching server answered ${reply.status}.`;
}

async function signal(event, lessonArg, title) {
  const signalToSend = checkSignal(event, lessonArg, title);
  const reply = await ask('POST', '/signal', signalToSend);
  if (reply === null) {
    dropFile(signalToSend);
    console.log('The teaching server is not reachable, so the signal was left as a file in .teach/signals/ for it to pick up.');
    return 0;
  }
  if (reply.status !== 200) throw new Refusal(refusedBy(reply));
  const pages = reply.body && Number.isInteger(reply.body.delivered) ? reply.body.delivered : 0;
  console.log(`Sent ${event} for ${signalToSend.lesson} to ${pages} open page${pages === 1 ? '' : 's'}.`);
  return 0;
}

async function stateCommand(method, route) {
  const reply = await ask(method, route, method === 'POST' ? {} : undefined);
  if (reply === null) throw new Refusal(NOT_RUNNING);
  if (reply.status !== 200 && reply.status !== 202) throw new Refusal(refusedBy(reply));
  console.log(JSON.stringify(reply.body));
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'status' || command === 'retry') {
    if (rest.length) throw new Refusal(`"${command}" takes no arguments.\n${USAGE}`);
    return command === 'status' ? stateCommand('GET', '/handshake') : stateCommand('POST', '/retry');
  }
  if (command === 'next-lesson' || command === 'reload') {
    const expected = command === 'reload' ? 1 : 2;
    if (rest.length !== expected) throw new Refusal(`"${command}" takes ${expected === 1 ? 'a lesson path' : 'a lesson path and a title'}.\n${USAGE}`);
    return signal(command, rest[0], rest[1]);
  }
  throw new Refusal(USAGE);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Refusal ? err.message : `Could not signal: ${err.message}`}\n`);
    process.exit(err instanceof Refusal ? 1 : 2);
  },
);
