'use strict';
// What the widget needs from the server to show the permission notice: the adapter's own words,
// and whether the connector was improvised.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../bridge/server');
const { makeWorkspace, get } = require('./helpers');
const { PASSING, fail, withHandshake, awaitVerdict, retryHandshake } = require('./handshake-helpers');
const { sendMessage } = require('./chat-helpers');

test('the interactive state carries exactly the permission text the adapter reported from check', async (t) => {
  const permissions = 'Reads and edits files in this workspace. Runs only the signalling command. No browser.';
  const { server } = await withHandshake(t, { ...PASSING, check: { type: 'result', ok: true, permissions } });

  const state = await awaitVerdict(server);

  assert.equal(state.state, 'interactive');
  assert.equal(state.permissions, permissions);
  assert.equal(state.improvised, undefined, 'an ordinary connector is not marked');
});

test('the permission text a page is shown is the one from the latest check', async (t) => {
  const { server, adapter } = await withHandshake(t, { ...PASSING, check: { type: 'result', ok: true, permissions: 'First words.' } });
  await awaitVerdict(server);
  // A setup error on send ends the session; the next handshake reports whatever the adapter says now.
  adapter.setScript({ ...PASSING, check: { type: 'result', ok: true, permissions: 'Second words.' }, send: fail('not-logged-in') });
  assert.equal((await sendMessage(server, { text: 'hi' })).status, 202);
  await awaitVerdict(server, (s) => s.state === 'static');

  await retryHandshake(server);
  const state = await awaitVerdict(server, (s) => s.state === 'interactive');
  assert.equal(state.permissions, 'Second words.');
});

test('a state with no chat does not carry permission text', async (t) => {
  const { server } = await withHandshake(t, { ...PASSING, check: fail('missing', { hint: 'Install it.' }) });
  const state = await awaitVerdict(server);
  assert.equal(state.state, 'static');
  assert.equal(state.permissions, undefined);
  assert.equal(state.improvised, undefined);
});

test('a connector marked improvised is reported as improvised once it is interactive, and stays so after a retry', async (t) => {
  const { server, adapter } = await withHandshake(t, PASSING, { server: { improvised: true } });

  const state = await awaitVerdict(server);
  assert.equal(state.state, 'interactive');
  assert.equal(state.improvised, true);

  adapter.setScript({ ...PASSING, send: fail('not-logged-in') });
  await sendMessage(server, { text: 'hi' });
  await awaitVerdict(server, (s) => s.state === 'static');
  adapter.setScript(PASSING);
  await retryHandshake(server);
  assert.equal((await awaitVerdict(server, (s) => s.state === 'interactive')).improvised, true);
});

test('a session given up front can carry its permission text and improvised mark, for tests and the dev harness', async (t) => {
  const ws = makeWorkspace({});
  const server = await startServer({
    workspace: ws.dir,
    bind: { mode: 'loopback' },
    adapter: ['node', 'unused.js'],
    session: 'sess-1',
    permissions: 'Everything the agent can do.',
    improvised: true,
  });
  t.after(async () => {
    await server.close();
    ws.cleanup();
  });

  const state = await (await get(server, '/handshake')).json();

  assert.deepEqual(state, { state: 'interactive', generation: 1, permissions: 'Everything the agent can do.', improvised: true });
});
