'use strict';
// Shared by the chat tests: a real server with a scripted fake adapter behind it.
const assert = require('node:assert/strict');
const { startServer } = require('../bridge/server');
const { makeWorkspace, post, get } = require('./helpers');
const { fakeAdapter } = require('./fake-adapter-client');

const LESSON = '<!doctype html><html><body><h1>Loops</h1></body></html>';
const LESSON_PATH = '/lessons/0001-loops.html';
const reply = (text) => ({ type: 'result', ok: true, text });
const failure = (code, extra = {}) => ({ type: 'result', ok: false, error: { code, message: `${code} happened`, ...extra } });

async function withChat(t, script, options = {}) {
  const ws = makeWorkspace({ 'lessons/0001-loops.html': LESSON, 'lessons/0002-lists.html': LESSON });
  const adapter = fakeAdapter(script);
  const server = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: adapter.command,
    session: 'sess-1',
    ...options,
  });
  t.after(async () => {
    await server.close();
    adapter.cleanup();
    ws.cleanup();
  });
  return { ws, server, adapter };
}

const sendMessage = (server, message, token) =>
  post(server, '/send', { id: 'm1', lesson: LESSON_PATH, text: 'What is a loop?', ...message }, token);

// Poll the reply route until the message is no longer pending.
async function awaitReply(server, id, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const body = await (await get(server, `/reply/${id}`)).json();
    if (body.status !== 'pending') return body;
    if (Date.now() > deadline) throw new Error('reply still pending');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function replyTo(server, id, message = {}) {
  assert.equal((await sendMessage(server, { id, ...message })).status, 202);
  return awaitReply(server, id);
}

module.exports = { LESSON, LESSON_PATH, reply, failure, withChat, sendMessage, awaitReply, replyTo };
