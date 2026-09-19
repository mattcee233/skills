'use strict';
// How messages are queued, timed out and remembered while the adapter works.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../bridge/server');
const { get } = require('./helpers');
const { reply, withChat, sendMessage, awaitReply, replyTo } = require('./chat-helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SLOW = 250;

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error('condition not met in time');
}

test('two messages for one session run one at a time, in the order they were sent', async (t) => {
  const { server, adapter } = await withChat(t, { send: reply('ok'), delayMs: { send: SLOW } });

  assert.equal((await sendMessage(server, { id: 'first', text: 'one' })).status, 202);
  assert.equal((await sendMessage(server, { id: 'second', text: 'two' })).status, 202);
  await awaitReply(server, 'first');
  await awaitReply(server, 'second');

  const [a, b] = adapter.calls('send');
  assert.deepEqual([a, b].map((c) => c.request.text.split('\n')[1]), ['one', 'two']);
  assert.ok(b.startedAt - a.startedAt >= SLOW - 30, `the second call started ${b.startedAt - a.startedAt}ms after the first`);
});

test('the fourth message queued for one session is refused with "failed", and is never run', async (t) => {
  const { server, adapter } = await withChat(t, { send: reply('ok'), delayMs: { send: SLOW } });

  for (const id of ['q1', 'q2', 'q3']) assert.equal((await sendMessage(server, { id })).status, 202, id);
  const refused = await sendMessage(server, { id: 'q4' });
  assert.equal(refused.status, 429);
  const body = await refused.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'failed');
  assert.match(body.error.message, /wait/i);

  for (const id of ['q1', 'q2', 'q3']) await awaitReply(server, id);
  assert.equal(adapter.calls('send').length, 3);
  assert.equal((await (await get(server, '/reply/q4')).json()).status, 'unknown');

  assert.equal((await sendMessage(server, { id: 'q5' })).status, 202, 'room again once the queue has drained');
  await awaitReply(server, 'q5');
});

test('messages for different sessions run in parallel', async (t) => {
  const { server, adapter } = await withChat(t, { send: reply('ok'), delayMs: { send: SLOW } });

  assert.equal((await sendMessage(server, { id: 'old' })).status, 202);
  server.setSession('sess-2');
  assert.equal((await sendMessage(server, { id: 'new' })).status, 202);
  await awaitReply(server, 'old');
  await awaitReply(server, 'new');

  const [a, b] = adapter.calls('send');
  assert.deepEqual([a.request.session, b.request.session].sort(), ['sess-1', 'sess-2']);
  assert.ok(Math.abs(b.startedAt - a.startedAt) < SLOW - 30, 'the second session did not wait for the first');
});

test('a slow adapter is killed at the deadline and reported as "timeout", and the message is not sent again', async (t) => {
  const { ws, server, adapter } = await withChat(
    t,
    { send: reply('too late'), delayMs: { send: 1500 }, touchOnFinish: 'finished.txt' },
    { sendTimeoutMs: 200 },
  );

  const started = Date.now();
  const { status, result } = await replyTo(server, 'slow');
  assert.equal(status, 'done');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
  assert.ok(Date.now() - started < 1200, 'answered at the deadline, not when the adapter finished');

  await sleep(1800);
  assert.equal(adapter.calls('send').length, 1, 'never resent on its own');
  assert.equal(fs.existsSync(path.join(ws.dir, 'finished.txt')), false, 'the child was killed, not left to finish');
});

test('a timed-out message does not hold up the next one in the queue', async (t) => {
  const { server, adapter } = await withChat(t, { send: reply('ok'), delayMs: { send: 1500 } }, { sendTimeoutMs: 200 });
  assert.equal((await sendMessage(server, { id: 'a' })).status, 202);
  assert.equal((await sendMessage(server, { id: 'b' })).status, 202);

  assert.equal((await awaitReply(server, 'a')).result.error.code, 'timeout');
  adapter.setScript({ send: reply('quick') });
  assert.deepEqual((await awaitReply(server, 'b')).result, { ok: true, text: 'quick' });
});

test('a message still being worked on reports "pending", then delivers its reply exactly once', async (t) => {
  const { server } = await withChat(t, { send: reply('Here you go.'), delayMs: { send: SLOW } });
  await sendMessage(server, { id: 'r1' });

  assert.deepEqual(await (await get(server, '/reply/r1')).json(), { status: 'pending' });
  assert.deepEqual(await awaitReply(server, 'r1'), { status: 'done', result: { ok: true, text: 'Here you go.' } });
  assert.deepEqual(await (await get(server, '/reply/r1')).json(), { status: 'unknown' }, 'dropped once fetched');
});

test('a reply nobody collects is dropped after its time is up', async (t) => {
  const { server } = await withChat(t, { send: reply('ok') }, { resultTtlMs: 100 });
  await sendMessage(server, { id: 'forgotten' });
  await sleep(400);
  assert.deepEqual(await (await get(server, '/reply/forgotten')).json(), { status: 'unknown' });
});

test('after the server restarts, a reply that was pending is "unknown" and is never re-run', async (t) => {
  const { ws, server, adapter } = await withChat(t, { send: reply('ok'), delayMs: { send: SLOW } });
  await sendMessage(server, { id: 'before' });
  await until(() => adapter.calls('send').length === 1);
  await server.close();
  await sleep(SLOW + 100);

  const restarted = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' }, adapter: adapter.command, session: 'sess-9' });
  t.after(() => restarted.close());
  assert.deepEqual(await (await get(restarted, '/reply/before')).json(), { status: 'unknown' });
  assert.equal(adapter.calls('send').length, 1);
});

test('sending the same message id again does not run it again', async (t) => {
  const { server, adapter } = await withChat(t, { send: reply('ok'), delayMs: { send: SLOW } });
  assert.equal((await sendMessage(server, { id: 'dup' })).status, 202);
  assert.equal((await sendMessage(server, { id: 'dup', text: 'changed my mind' })).status, 202);
  await awaitReply(server, 'dup');
  assert.equal(adapter.calls('send').length, 1);
  assert.match(adapter.calls('send')[0].request.text, /What is a loop\?/);
});

test('the adapter is run with a scrubbed environment: no token, no secrets from the server\'s own', async (t) => {
  process.env.TEACH_TEST_SECRET = 'hunter2';
  process.env.TEACH_TOKEN = 'leaky';
  t.after(() => {
    delete process.env.TEACH_TEST_SECRET;
    delete process.env.TEACH_TOKEN;
  });
  const { ws, server, adapter } = await withChat(t, { send: reply('ok') });
  await replyTo(server, 'env');

  const { env, cwd } = adapter.calls('send')[0];
  const serialised = JSON.stringify(env);
  assert.equal('TEACH_TEST_SECRET' in env, false);
  assert.equal('TEACH_TOKEN' in env, false);
  assert.equal(serialised.includes(server.token), false);
  assert.equal(serialised.includes('hunter2'), false);
  assert.ok(env.PATH || env.Path, 'the adapter can still find programs on the path');
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(ws.dir), 'runs in the workspace');
});

test('a message id is never run again, even after its reply has been collected', async (t) => {
  const { server, adapter } = await withChat(t, { send: reply('ok') });
  await replyTo(server, 'once');
  assert.equal((await sendMessage(server, { id: 'once' })).status, 202);
  await sleep(300);
  assert.equal(adapter.calls('send').length, 1);
  assert.deepEqual(await (await get(server, '/reply/once')).json(), { status: 'unknown' });
});
