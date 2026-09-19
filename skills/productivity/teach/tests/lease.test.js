'use strict';
// The interactive lease, through the server: which page has live chat, and how that moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../bridge/server');
const { makeWorkspace, openEvents, openTab, takeLease, post, get, url } = require('./helpers');
const { fakeAdapter } = require('./fake-adapter-client');
const { LESSON, reply, sendMessage } = require('./chat-helpers');

const GRACE_MS = 120;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (page, name) => (page.received.match(new RegExp(`event: ${name}\\n`, 'g')) || []).length;
const leaseFrames = (page) => [...page.received.matchAll(/event: lease\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).state);

async function withLease(t, script = { send: reply('A reply.') }, options = {}) {
  const ws = makeWorkspace({ 'lessons/0001-loops.html': LESSON, 'lessons/0002-lists.html': LESSON });
  const adapter = fakeAdapter(script);
  const server = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: adapter.command,
    session: 'sess-1',
    leaseGraceMs: GRACE_MS,
    ...options,
  });
  const pages = [];
  const open = async (tab) => {
    const page = await openTab(server, tab);
    pages.push(page);
    return page;
  };
  t.after(async () => {
    pages.forEach((p) => p.close());
    await server.close();
    adapter.cleanup();
    ws.cleanup();
  });
  return { ws, server, adapter, open };
}

const send = (server, tab, id = 'm1') => sendMessage(server, { id }, undefined, tab);

test('the first page to connect holds the lease and a second is told it is not interactive', async (t) => {
  const { server, open } = await withLease(t);
  const first = await open('tab-a');
  const second = await open('tab-b');

  await first.waitFor(/event: lease\ndata: .*\n/);
  await second.waitFor(/event: lease\ndata: .*\n/);
  assert.deepEqual(leaseFrames(first), ['interactive']);
  assert.deepEqual(leaseFrames(second), ['not-interactive']);

  // Both pages still read lessons.
  assert.equal((await fetch(url(server, '/lessons/0001-loops.html'))).status, 200);
});

test('a send from the non-holder is refused with in-use, and so is one that names no tab', async (t) => {
  const { server, adapter, open } = await withLease(t);
  await open('tab-a');
  await open('tab-b');

  const refused = await send(server, 'tab-b');
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'in-use');
  const anonymous = await sendMessage(server, { id: 'm2' }, undefined, null);
  assert.equal(anonymous.status, 409);
  assert.equal(adapter.calls('send').length, 0, 'the adapter was never called');

  assert.equal((await send(server, 'tab-a', 'm3')).status, 202);
});

test('a page that never connected cannot send, even if it names a tab, and is told nobody else has it', async (t) => {
  const { server } = await withLease(t);
  const refused = await send(server, 'tab-ghost');
  assert.equal(refused.status, 409);
  const { error } = await refused.json();
  assert.equal(error.code, 'in-use');
  assert.doesNotMatch(error.message, /another page/i);
});

test('taking over displaces the old holder and makes the new page interactive', async (t) => {
  const { server, open } = await withLease(t);
  const first = await open('tab-a');
  const second = await open('tab-b');
  await second.waitFor(/event: lease/);

  const res = await takeLease(server, 'tab-b');

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, state: 'interactive' });
  await first.waitFor(/event: displaced\ndata: \{\}\n/);
  await second.waitFor(/data: \{"state":"interactive"\}/);
  assert.deepEqual(leaseFrames(second), ['not-interactive', 'interactive']);
  assert.equal((await send(server, 'tab-a')).status, 409, 'the old holder can no longer send');
  assert.equal((await send(server, 'tab-b', 'm2')).status, 202, 'the new holder can');
});

test('every connection of the new holder hears that it is interactive', async (t) => {
  const { server, open } = await withLease(t);
  await open('tab-a');
  const second = await open('tab-b');
  const secondAgain = await open('tab-b');
  await secondAgain.waitFor(/event: lease/);

  await takeLease(server, 'tab-b');

  await second.waitFor(/data: \{"state":"interactive"\}/);
  await secondAgain.waitFor(/data: \{"state":"interactive"\}/);
});

test('taking the lease when you already hold it changes nothing and displaces nobody', async (t) => {
  const { server, open } = await withLease(t);
  const first = await open('tab-a');
  await first.waitFor(/event: lease/);

  const res = await takeLease(server, 'tab-a');

  assert.equal(res.status, 200);
  await pause(50);
  assert.equal(count(first, 'displaced'), 0);
});

test('the takeover route needs the token, a well-formed tab id and a connected page', async (t) => {
  const { server, open } = await withLease(t);
  const first = await open('tab-a');
  await first.waitFor(/event: lease/);

  assert.equal((await post(server, '/lease/take', {}, null, 'tab-a')).status, 401);
  assert.equal((await post(server, '/lease/take', {}, 'wrong', 'tab-a')).status, 401);
  assert.equal((await post(server, '/lease/take', {}, server.token, null)).status, 400);
  assert.equal((await post(server, '/lease/take', {}, server.token, 'bad id!')).status, 400);
  const ghost = await takeLease(server, 'tab-ghost');
  assert.equal(ghost.status, 409);
  assert.equal((await send(server, 'tab-a')).status, 202, 'nothing above moved the lease');
});

test('the event stream refuses a malformed tab id, and needs the token as before', async (t) => {
  const { server } = await withLease(t);
  const bad = await openEvents(server, server.token, '127.0.0.1', 'not a tab id!');
  assert.equal(bad.response.status, 400);
  const noToken = await openEvents(server, null, '127.0.0.1', 'tab-a');
  assert.equal(noToken.response.status, 401);
});

test('a stream that names no tab is a plain observer: it gets no lease frame and holds nothing', async (t) => {
  const { server, open } = await withLease(t);
  const observer = await openEvents(server, server.token);
  t.after(() => observer.close());
  const holder = await open('tab-a');
  await holder.waitFor(/event: lease/);

  await pause(50);
  assert.equal(count(observer, 'lease'), 0);
  assert.deepEqual(leaseFrames(holder), ['interactive']);
});

test('same-tab navigation keeps the lease, whichever connection comes first', async (t) => {
  const { server, open } = await withLease(t);
  const before = await open('tab-a');
  const other = await open('tab-b');
  await other.waitFor(/event: lease/);

  // The next lesson opens its stream before the old page's stream has closed.
  const after = await open('tab-a');
  await after.waitFor(/event: lease/);
  assert.deepEqual(leaseFrames(after), ['interactive']);
  before.close();
  await pause(GRACE_MS * 3);

  assert.equal((await send(server, 'tab-a')).status, 202);
  assert.equal(count(other, 'lease-free'), 0);
  assert.equal(count(after, 'displaced'), 0);
});

test('a holder that reconnects within the grace period keeps the lease and nobody is told it was free', async (t) => {
  const { server, open } = await withLease(t);
  const before = await open('tab-a');
  const other = await open('tab-b');
  await other.waitFor(/event: lease/);
  before.close();
  await pause(GRACE_MS / 3);

  const after = await open('tab-a');
  await after.waitFor(/event: lease/);
  assert.deepEqual(leaseFrames(after), ['interactive']);
  await pause(GRACE_MS * 3);

  assert.equal(count(other, 'lease-free'), 0);
  assert.equal((await send(server, 'tab-a')).status, 202);
  assert.equal((await send(server, 'tab-b', 'm2')).status, 409);
});

test('closing the holder frees the lease after the grace period, tells the others, and claims nothing', async (t) => {
  const { server, open } = await withLease(t);
  const holder = await open('tab-a');
  const other = await open('tab-b');
  await other.waitFor(/event: lease/);

  holder.close();
  await pause(GRACE_MS / 3);
  assert.equal(count(other, 'lease-free'), 0, 'not before the grace period is over');
  await other.waitFor(/event: lease-free\ndata: \{\}\n/, GRACE_MS * 10);

  assert.deepEqual(leaseFrames(other), ['not-interactive'], 'the other page was not made interactive');
  assert.equal((await send(server, 'tab-b')).status, 409, 'and cannot send until it takes the lease');
  assert.equal((await takeLease(server, 'tab-b')).status, 200);
  assert.equal((await send(server, 'tab-b', 'm2')).status, 202);
});

test('a page that connects while the lease is free holds it, since nobody does', async (t) => {
  const { server, open } = await withLease(t);
  const holder = await open('tab-a');
  await holder.waitFor(/event: lease/);
  holder.close();
  await pause(GRACE_MS * 3);

  const late = await open('tab-b');
  await late.waitFor(/event: lease/);
  assert.deepEqual(leaseFrames(late), ['interactive']);
  assert.equal((await send(server, 'tab-b')).status, 202);
});

test('a page that connects while the holder is inside its grace period is not interactive, and hears lease-free after', async (t) => {
  const { open } = await withLease(t);
  const holder = await open('tab-a');
  await holder.waitFor(/event: lease/);
  holder.close();
  await pause(GRACE_MS / 4);

  const late = await open('tab-b');
  await late.waitFor(/event: lease/);
  assert.deepEqual(leaseFrames(late), ['not-interactive']);
  await late.waitFor(/event: lease-free/, GRACE_MS * 10);
});

test('a non-holder closing changes nothing for the holder', async (t) => {
  const { server, open } = await withLease(t);
  const holder = await open('tab-a');
  const other = await open('tab-b');
  await other.waitFor(/event: lease/);
  other.close();
  await pause(GRACE_MS * 3);

  assert.equal(count(holder, 'lease-free'), 0);
  assert.equal((await send(server, 'tab-a')).status, 202);
});

test('a reply that completes after the holder left is fetched by the next holder', async (t) => {
  const { server, open } = await withLease(t, { send: reply('Slow answer.'), delayMs: { send: 500 } });
  const holder = await open('tab-a');
  const other = await open('tab-b');
  await other.waitFor(/event: lease/);
  assert.equal((await send(server, 'tab-a', 'slow-1')).status, 202);

  holder.close();
  await other.waitFor(/event: lease-free/, GRACE_MS * 10);
  assert.equal((await takeLease(server, 'tab-b')).status, 200);

  // The page that took over finds the message id in the shared thread and asks for it.
  for (let waited = 0; ; waited += 25) {
    const body = await (await get(server, '/reply/slow-1')).json();
    if (body.status === 'done') {
      assert.deepEqual(body.result, { ok: true, text: 'Slow answer.' });
      break;
    }
    assert.equal(body.status, 'pending');
    assert.ok(waited < 5000, 'the reply never arrived');
    await pause(25);
  }
});

test('closing the server cancels a pending release', async (t) => {
  const ws = makeWorkspace({});
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' }, leaseGraceMs: 60000 });
  t.after(() => ws.cleanup());
  const holder = await openTab(server, 'tab-a');
  await holder.waitFor(/event: lease/);
  holder.close();
  await pause(50);
  const started = Date.now();
  await server.close();
  assert.ok(Date.now() - started < 2000);
});
