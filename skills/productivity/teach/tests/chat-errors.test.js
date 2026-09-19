'use strict';
// What the page is told when the adapter fails, or misbehaves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reply, failure, withChat, replyTo } = require('./chat-helpers');

// One server per code: an error that needs the learner's action (missing, not-logged-in,
// unauthorised) ends the session for good, so codes cannot share one.
for (const code of ['missing', 'not-logged-in', 'unreachable', 'unauthorised', 'timeout', 'in-use', 'failed']) {
  test(`the "${code}" error code reaches the page with its message and hint`, async (t) => {
    const { server } = await withChat(t, { send: failure(code, { hint: `Fix for ${code}.` }) });
    assert.deepEqual(await replyTo(server, `e-${code}`), {
      status: 'done',
      result: { ok: false, error: { code, message: `${code} happened`, hint: `Fix for ${code}.` } },
    });
  });
}

test('a code outside the closed set becomes "failed", and an error with no hint carries none', async (t) => {
  const { server, adapter } = await withChat(t, { send: failure('rate-limited') });
  const first = await replyTo(server, 'a');
  assert.equal(first.result.error.code, 'failed');
  assert.equal('hint' in first.result.error, false);

  adapter.setScript({ send: { type: 'result', ok: false, error: { code: 'timeout' } } });
  const second = await replyTo(server, 'b');
  assert.equal(second.result.error.code, 'timeout');
  assert.equal(typeof second.result.error.message, 'string');
  assert.ok(second.result.error.message.length > 0, 'a missing message gets a safe default');
});

test('a hint that is not a string, is too long, or is not plain text is dropped, and control characters are removed', async (t) => {
  const { server, adapter } = await withChat(t, {});
  let count = 0;
  const hintFor = async (hint) => {
    adapter.setScript({ send: failure('failed', { hint }) });
    return (await replyTo(server, `h${(count += 1)}`)).result.error.hint;
  };

  assert.equal(await hintFor(42), undefined);
  assert.equal(await hintFor({ text: 'Log in.' }), undefined);
  assert.equal(await hintFor(['Log in.']), undefined);
  assert.equal(await hintFor(null), undefined);
  assert.equal(await hintFor('x'.repeat(2000)), undefined);
  assert.equal(await hintFor('Run <script>alert(1)</script> now'), undefined);
  assert.equal(await hintFor('Click <a href="http://evil.example">here</a>'), undefined);
  assert.equal(await hintFor(''), undefined);
  assert.equal(await hintFor('   \n '), undefined);
  assert.equal(await hintFor('Run `claude auth login`.' + String.fromCharCode(0, 7)), 'Run `claude auth login`.');
  assert.equal(await hintFor('Start agy, then\nrun /login.'), 'Start agy, then run /login.');
  assert.equal(await hintFor('Use a < b, then c > d.'), 'Use a < b, then c > d.');
});

test('a message that is not safe text is replaced by a default for its code', async (t) => {
  const { server, adapter } = await withChat(t, {});
  let count = 0;
  for (const message of [42, '<img src=x onerror=alert(1)>', 'x'.repeat(2000), '']) {
    adapter.setScript({ send: { type: 'result', ok: false, error: { code: 'unreachable', message } } });
    const { result } = await replyTo(server, `m${(count += 1)}`);
    assert.equal(result.error.code, 'unreachable');
    assert.match(result.error.message, /^[A-Z][\w ,.'-]+\.$/);
  }
});

test('an adapter that misbehaves produces a "failed" error, never a crash or a hang', async (t) => {
  const { server, adapter } = await withChat(t, {});
  const misbehaviours = {
    'no output at all': { rawOutput: '' },
    'output that is not JSON': { rawOutput: 'Segmentation fault\n' },
    'a JSON value that is not an object': { rawOutput: '"hello"\n' },
    'JSON without a type tag': { rawOutput: '{"ok":true,"text":"hi"}\n' },
    'a result whose ok is not a boolean': { rawOutput: '{"type":"result","ok":"yes","text":"hi"}\n' },
    'a successful result with no text': { rawOutput: '{"type":"result","ok":true}\n' },
    'a successful result whose text is not a string': { rawOutput: '{"type":"result","ok":true,"text":{"a":1}}\n' },
    'an error result with no error object': { rawOutput: '{"type":"result","ok":false}\n' },
    'only progress lines': { rawOutput: '{"type":"progress","text":"working"}\n' },
    'a non-zero exit with no result': { rawOutput: '', exitCode: 3 },
  };
  let count = 0;
  for (const [name, script] of Object.entries(misbehaviours)) {
    adapter.setScript(script);
    const { status, result } = await replyTo(server, `x${(count += 1)}`);
    assert.equal(status, 'done', name);
    assert.equal(result.ok, false, name);
    assert.equal(result.error.code, 'failed', name);
  }
});

test('a program that cannot be started is reported as "failed"', async (t) => {
  const { server } = await withChat(t, {}, { adapter: ['definitely-not-a-real-program-teach'] });
  const { result } = await replyTo(server, 'gone');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'failed');
});

test('progress lines before the result are ignored in v1', async (t) => {
  const { server } = await withChat(t, {
    progressLines: [{ type: 'progress', text: 'reading the lesson' }, { type: 'progress', text: 'thinking' }],
    send: reply('The answer.'),
  });
  assert.deepEqual((await replyTo(server, 'p')).result, { ok: true, text: 'The answer.' });
});

test('chat is refused with a clear error until a session identity is known', async (t) => {
  const { server, adapter } = await withChat(t, { send: reply('ok') }, { session: null });
  const { result } = await replyTo(server, 'early');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'failed');
  assert.equal(adapter.calls().length, 0);

  server.setSession('sess-2');
  assert.equal((await replyTo(server, 'later')).result.ok, true);
  assert.equal(adapter.calls('send')[0].request.session, 'sess-2');
});

test('an error code that is not a plain string becomes "failed"', async (t) => {
  const { server, adapter } = await withChat(t, {});
  for (const code of [['missing'], { toString: 'missing' }, 42, null]) {
    adapter.setScript({ send: { type: 'result', ok: false, error: { code, message: 'Nope.' } } });
    const { result } = await replyTo(server, `c${String(JSON.stringify(code)).length}${typeof code}`);
    assert.equal(result.error.code, 'failed', JSON.stringify(code));
  }
});

test('an adapter that floods its output is stopped and reported as "failed"', async (t) => {
  const { server } = await withChat(t, { rawOutput: 'x'.repeat(3 * 1024 * 1024) + String.fromCharCode(10) + JSON.stringify({ type: 'result', ok: true, text: 'late' }) });
  const { result } = await replyTo(server, 'flood');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'failed');
});
