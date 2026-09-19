'use strict';
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { get, post, openEvents } = require('./helpers');
const { PASSING, PERMISSIONS, ok, fail, withHandshake, handshakeState, awaitVerdict, retryHandshake } = require('./handshake-helpers');
const { awaitReply, replyTo, sendMessage } = require('./chat-helpers');

test('a passing check and prime give an interactive session that can chat', async (t) => {
  const { server, adapter } = await withHandshake(t, PASSING);

  const verdict = await awaitVerdict(server);
  assert.equal(verdict.state, 'interactive');
  assert.equal(verdict.permissions, PERMISSIONS);

  // The session identity the adapter made up is handed back on send, and never shown to the page.
  assert.equal(JSON.stringify(verdict).includes('sess-1'), false);
  assert.equal((await sendMessage(server, { id: 'm1', lesson: '/lessons/0001-loops.html' })).status, 202);
  assert.deepEqual((await awaitReply(server, 'm1')).result, { ok: true, text: 'A reply.' });
  assert.equal(adapter.calls('send')[0].request.session, 'sess-1');
});

test('the handshake state needs the session token', async (t) => {
  const { server } = await withHandshake(t, PASSING);
  assert.equal((await get(server, '/handshake', null)).status, 401);
  assert.equal((await get(server, '/handshake', 'not-the-token')).status, 401);
});

for (const code of ['missing', 'not-logged-in', 'unreachable', 'unauthorised']) {
  test(`a check that fails with "${code}" gives a not-connected state with the adapter's hint, and never primes`, async (t) => {
    const { server, adapter } = await withHandshake(t, { ...PASSING, check: fail(code, { hint: `Fix for ${code}.` }) });

    const verdict = await awaitVerdict(server);
    assert.equal(verdict.state, 'static');
    assert.equal(verdict.reason, code);
    assert.equal(verdict.hint, `Fix for ${code}.`);
    assert.equal(verdict.message, `${code} happened`);
    assert.equal(adapter.calls('prime').length, 0);
  });
}

test('a failed check without a hint leaves the hint empty, for the widget to fall back on its own wording', async (t) => {
  const { server } = await withHandshake(t, { ...PASSING, check: fail('missing') });
  const verdict = await awaitVerdict(server);
  assert.equal(verdict.state, 'static');
  assert.equal(verdict.hint, undefined);
});

test('a prime that creates a workspace file fails conformance, and chat is not connected', async (t) => {
  const { server } = await withHandshake(t, { ...PASSING, writeFileOnPrime: 'lessons/0002-sneaky.html' });

  const verdict = await awaitVerdict(server);
  assert.equal(verdict.state, 'static');
  assert.equal(verdict.reason, 'conformance');
  assert.ok(verdict.hint, 'the learner is told what to do');
  const sent = await replyTo(server, 'm1', { lesson: '/lessons/0001-loops.html' });
  assert.equal(sent.result.error.message, 'Chat is not connected yet.');
});

test('a prime that edits an existing workspace file fails conformance', async (t) => {
  const { server, ws } = await withHandshake(t, { ...PASSING, writeFileOnPrime: 'MISSION.md' });
  assert.equal((await awaitVerdict(server)).reason, 'conformance');
  assert.notEqual(fs.readFileSync(path.join(ws.dir, 'MISSION.md'), 'utf8'), 'Learn loops.');
});

const MALFORMED_CHECKS = {
  'no type tag': { ok: true, permissions: PERMISSIONS },
  'an unknown error code': { type: 'result', ok: false, error: { code: 'exploded', message: 'Boom' } },
  'an over-long hint': fail('missing', { hint: 'x'.repeat(400) }),
  'an HTML hint': fail('missing', { hint: 'Run <b>this</b> now' }),
  'a hint that is not text': fail('missing', { hint: { text: 'Log in' } }),
  'an error with no message': { type: 'result', ok: false, error: { code: 'missing' } },
  'no permissions text': { type: 'result', ok: true },
  'a result that is neither ok nor an error': { type: 'result' },
};

for (const [what, check] of Object.entries(MALFORMED_CHECKS)) {
  test(`a check answering with ${what} fails conformance, without priming`, async (t) => {
    const { server, adapter } = await withHandshake(t, { ...PASSING, check });
    const verdict = await awaitVerdict(server);
    assert.equal(verdict.state, 'static');
    assert.equal(verdict.reason, 'conformance');
    assert.ok(verdict.hint);
    assert.equal(adapter.calls('prime').length, 0);
  });
}

const MALFORMED_PRIMES = {
  'no type tag': { ok: true, session: 'sess-1' },
  'no session identity': { type: 'result', ok: true },
  'an empty session identity': { type: 'result', ok: true, session: '' },
  'a session identity that is not text': { type: 'result', ok: true, session: 42 },
  'an unknown error code': { type: 'result', ok: false, error: { code: 'exploded', message: 'Boom' } },
};

for (const [what, prime] of Object.entries(MALFORMED_PRIMES)) {
  test(`a prime answering with ${what} fails conformance, and no session is kept`, async (t) => {
    const { server } = await withHandshake(t, { ...PASSING, prime });
    assert.equal((await awaitVerdict(server)).reason, 'conformance');
    assert.equal((await replyTo(server, 'm1', { lesson: '/lessons/0001-loops.html' })).result.error.message, 'Chat is not connected yet.');
  });
}

for (const [what, rawOutput] of Object.entries({
  'text that is not JSON': 'hello there\n',
  'nothing at all': '',
  'two results': `${JSON.stringify(PASSING.check)}\n${JSON.stringify(PASSING.check)}\n`,
  'a line that is not JSON beside the result': `oops\n${JSON.stringify(PASSING.check)}\n`,
})) {
  test(`a check writing ${what} fails conformance`, async (t) => {
    const { server } = await withHandshake(t, { ...PASSING, rawOutput });
    assert.equal((await awaitVerdict(server)).reason, 'conformance');
  });
}

test('progress lines before the result are allowed and ignored', async (t) => {
  const { server } = await withHandshake(t, { ...PASSING, progressLines: [{ type: 'progress', note: 'thinking' }] });
  assert.equal((await awaitVerdict(server)).state, 'interactive');
});

test('retry re-runs check then prime once the adapter passes, and the open page hears it without a reload', async (t) => {
  const { server, adapter } = await withHandshake(t, { ...PASSING, check: fail('not-logged-in', { hint: 'Log in first.' }) });
  const events = await openEvents(server, server.token);
  t.after(() => events.close());
  assert.equal((await awaitVerdict(server)).state, 'static');
  await events.waitFor(/event: handshake\ndata: \{[^\n]*"state":"static"/);

  adapter.setScript(PASSING);
  const response = await retryHandshake(server);
  assert.equal(response.status, 202);
  assert.equal((await awaitVerdict(server)).state, 'interactive');
  await events.waitFor(/event: handshake\ndata: \{[^\n]*"state":"interactive"/);
  assert.deepEqual(adapter.calls().map((c) => c.request.op), ['check', 'check', 'prime']);
});

test('a retry that fails its check again stays not connected and does not prime', async (t) => {
  const { server, adapter } = await withHandshake(t, { ...PASSING, check: fail('missing', { hint: 'Install it.' }) });
  await awaitVerdict(server);

  await retryHandshake(server);
  await awaitVerdict(server, (state) => state.state === 'static');
  assert.equal(adapter.calls('prime').length, 0);
  assert.equal((await handshakeState(server)).hint, 'Install it.');
});

test('retry needs the session token', async (t) => {
  const { server } = await withHandshake(t, PASSING);
  assert.equal((await post(server, '/retry', {}, null)).status, 401);
});

test('a retry while the handshake is still running does not start a second one', async (t) => {
  const { server, adapter } = await withHandshake(t, { ...PASSING, delayMs: { check: 300 } });
  assert.equal((await handshakeState(server)).state, 'pending');
  const response = await retryHandshake(server);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).state, 'pending');
  assert.equal((await awaitVerdict(server)).state, 'interactive');
  assert.equal(adapter.calls('check').length, 1);
  assert.equal(adapter.calls('prime').length, 1);
});

test('a retry on a session that is already interactive changes nothing and costs no model turn', async (t) => {
  const { server, adapter } = await withHandshake(t, PASSING);
  await awaitVerdict(server);
  const response = await retryHandshake(server);
  assert.equal((await response.json()).state, 'interactive');
  assert.equal(adapter.calls().length, 2);
});

const LESSON = '/lessons/0001-loops.html';

for (const code of ['missing', 'not-logged-in', 'unauthorised']) {
  test(`a "${code}" error during a send returns the session to not connected, and the reply still carries the error`, async (t) => {
    const { server, adapter } = await withHandshake(t, PASSING);
    await awaitVerdict(server);
    const events = await openEvents(server, server.token);
    t.after(() => events.close());
    adapter.setScript({ ...PASSING, send: fail(code, { hint: `Fix for ${code}.` }) });

    const reply = await replyTo(server, 'm1', { lesson: LESSON });
    assert.equal(reply.result.error.code, code);

    const verdict = await awaitVerdict(server, (state) => state.state === 'static');
    assert.equal(verdict.reason, code);
    assert.equal(verdict.hint, `Fix for ${code}.`);
    await events.waitFor(/event: handshake\ndata: \{[^\n]*"state":"static"/);

    // The engine is unavailable now: nothing more is sent to it.
    const later = await replyTo(server, 'm2', { lesson: LESSON });
    assert.equal(later.result.error.message, 'Chat is not connected yet.');
    assert.equal(adapter.calls('send').length, 1);
  });
}

for (const code of ['timeout', 'failed', 'unreachable']) {
  test(`a "${code}" error during a send stays in live chat`, async (t) => {
    const { server, adapter } = await withHandshake(t, PASSING);
    await awaitVerdict(server);
    adapter.setScript({ ...PASSING, send: fail(code) });

    assert.equal((await replyTo(server, 'm1', { lesson: LESSON })).result.error.code, code);
    assert.equal((await handshakeState(server)).state, 'interactive');

    adapter.setScript(PASSING);
    assert.equal((await replyTo(server, 'm2', { lesson: LESSON })).result.ok, true);
  });
}

test('after a setup error, retry runs check then a new prime, and chat carries on in a fresh conversation', async (t) => {
  const { server, adapter } = await withHandshake(t, PASSING);
  assert.equal((await awaitVerdict(server)).generation, 1);
  adapter.setScript({ ...PASSING, send: fail('not-logged-in', { hint: 'Log in.' }) });
  await replyTo(server, 'm1', { lesson: LESSON });
  await awaitVerdict(server, (state) => state.state === 'static');

  adapter.setScript({ ...PASSING, prime: ok({ session: 'sess-2' }) });
  await retryHandshake(server);
  const verdict = await awaitVerdict(server, (state) => state.state === 'interactive');
  assert.equal(verdict.generation, 2);

  assert.equal((await replyTo(server, 'm2', { lesson: LESSON })).result.ok, true);
  assert.equal(adapter.calls('send').at(-1).request.session, 'sess-2');
  assert.deepEqual(adapter.calls().map((c) => c.request.op), ['check', 'prime', 'send', 'check', 'prime', 'send']);
});

test('a message queued behind one that hits a setup error is not sent to the engine', async (t) => {
  const { server, adapter } = await withHandshake(t, PASSING);
  await awaitVerdict(server);
  adapter.setScript({ ...PASSING, send: fail('not-logged-in'), delayMs: { send: 200 } });

  assert.equal((await sendMessage(server, { id: 'm1', lesson: LESSON })).status, 202);
  assert.equal((await sendMessage(server, { id: 'm2', lesson: LESSON })).status, 202);
  assert.equal((await awaitReply(server, 'm1')).result.error.code, 'not-logged-in');
  assert.equal((await awaitReply(server, 'm2')).result.error.message, 'Chat is not connected yet.');
  assert.equal(adapter.calls('send').length, 1);
});

test('a server given a session up front reports interactive without running a handshake', async (t) => {
  const { server, adapter } = await withHandshake(t, PASSING, { server: { session: 'given-1' } });
  assert.equal((await handshakeState(server)).state, 'interactive');
  assert.equal(adapter.calls().length, 0);
});

test('a server with no adapter reports not connected, and retry does not invent one', async (t) => {
  const { server } = await withHandshake(t, PASSING, { server: { adapter: null } });
  const verdict = await handshakeState(server);
  assert.equal(verdict.state, 'static');
  assert.equal(verdict.reason, 'no-adapter');
  await retryHandshake(server);
  assert.equal((await handshakeState(server)).reason, 'no-adapter');
});

test('a check that outruns its deadline is killed and gives a not-connected state with reason "timeout", without priming', async (t) => {
  const { server, adapter } = await withHandshake(t, { ...PASSING, delayMs: { check: 1500 } }, { server: { checkTimeoutMs: 150 } });
  const verdict = await awaitVerdict(server);
  assert.equal(verdict.state, 'static');
  assert.equal(verdict.reason, 'timeout');
  assert.equal(adapter.calls('prime').length, 0);
});

test('a prime that outruns its deadline gives a not-connected state with reason "timeout", and retry can recover', async (t) => {
  const { server, adapter } = await withHandshake(t, { ...PASSING, delayMs: { prime: 1500 } }, { server: { primeTimeoutMs: 150 } });
  assert.equal((await awaitVerdict(server)).reason, 'timeout');

  adapter.setScript(PASSING);
  await retryHandshake(server);
  assert.equal((await awaitVerdict(server)).state, 'interactive');
});

test('the prime request names the newest lesson, so the agent is told which lesson to read', async (t) => {
  const { server, adapter } = await withHandshake(t, PASSING, { files: { 'lessons/0002-lists.html': '<html><body><h1>Lists</h1></body></html>' } });
  await awaitVerdict(server);
  const { request } = adapter.calls('prime')[0];
  assert.equal(request.lesson, 'lessons/0002-lists.html');
  assert.equal(typeof request.instruction, 'string');
});

test('a prime that rewrites a file in the workspace-local folder fails conformance', async (t) => {
  const { server } = await withHandshake(t, { ...PASSING, writeFileOnPrime: '.teach/adapters/custom.js' });
  assert.equal((await awaitVerdict(server)).reason, 'conformance');
});

test('a prime that changes files and then reports an error still fails conformance', async (t) => {
  const { server } = await withHandshake(t, { ...PASSING, prime: fail('not-logged-in', { hint: 'Log in.' }), writeFileOnPrime: 'lessons/0002-sneaky.html' });
  assert.equal((await awaitVerdict(server)).reason, 'conformance');
});

test('files the server itself keeps in its folder (the state file, dropped signals) do not count as a change', async (t) => {
  const { server } = await withHandshake(t, { ...PASSING, writeFileOnPrime: '.teach/signals/next.json' });
  assert.equal((await awaitVerdict(server)).state, 'interactive');
});

test('any plain session identity is accepted, opaque to the server', async (t) => {
  const identity = 'conv  <a> 3a9f-Ünïcode';
  const { server, adapter } = await withHandshake(t, { ...PASSING, prime: ok({ session: identity }) });
  assert.equal((await awaitVerdict(server)).state, 'interactive');
  await replyTo(server, 'm1', { lesson: '/lessons/0001-loops.html' });
  assert.equal(adapter.calls('send')[0].request.session, identity);
});
