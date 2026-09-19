'use strict';
// The chat half of the bridge: runs the adapter for each message the page sends and holds
// the result by message id, so a page that reloaded can still collect its reply.
// Node built-ins only.
const { spawn } = require('node:child_process');

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT_LENGTH = 20000;
const MAX_NOTE_LENGTH = 300;
// Errors that mean the engine cannot be used until the learner fixes something.
const SETUP_CODES = new Set(['missing', 'not-logged-in', 'unauthorised']);
const QUEUE_CAP = 3;
// What a page may say a message is. The server, never the page, writes the line that goes before
// the learner's words, so a kind is a name from this closed set and nothing more.
const KINDS = new Set(['answer']);
const SEND_TIMEOUT_MS = 16 * 60 * 1000;
const RESULT_TTL_MS = 60 * 60 * 1000;
const MAX_OUTPUT_LENGTH = 2 * 1024 * 1024;

// The closed set of error codes, each with a safe message for when the adapter's own is
// missing or not plain text.
const DEFAULT_MESSAGES = {
  missing: "The teacher's engine is not installed.",
  'not-logged-in': "The teacher's engine is not logged in.",
  unreachable: 'The teacher could not be reached.',
  unauthorised: "The teacher's engine refused the credentials.",
  timeout: 'The teacher took too long to reply.',
  'in-use': 'Another page is using the chat.',
  failed: 'The teacher could not reply.',
};

// What an adapter's environment keeps from the server's own: enough to find programs and the
// user's login, and nothing else. An allow-list, so a secret in the server's environment never
// reaches a program the AI may have written.
const ENV_KEEP = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMDATA', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'LANG', 'TERM',
]);

function scrubbedEnv(env = process.env) {
  const kept = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (ENV_KEEP.has(upper) || upper.startsWith('LC_') || upper.startsWith('XDG_')) kept[name] = value;
  }
  return kept;
}

const CONTROL_CHARACTERS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`, 'g');

function failure(code, message = DEFAULT_MESSAGES[code]) {
  return { ok: false, error: { code, message } };
}

// Learner-facing text from an adapter: a string, plain text (no markup), short. Control
// characters are removed and line breaks become spaces. Anything else is dropped (null).
function plainText(value, maxLength = MAX_NOTE_LENGTH) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\t\n\r]+/g, ' ')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!text || text.length > maxLength || /<[A-Za-z/!?]/.test(text)) return null;
  return text;
}

// Turn the adapter's last "result" line into what the page receives; anything the contract
// does not allow becomes a plain "failed".
function toResult(parsed) {
  if (typeof parsed.ok !== 'boolean') return failure('failed');
  if (parsed.ok) {
    return typeof parsed.text === 'string' ? { ok: true, text: parsed.text } : failure('failed');
  }
  const given = parsed.error;
  if (!given || typeof given !== 'object') return failure('failed');
  const code = typeof given.code === 'string' && Object.hasOwn(DEFAULT_MESSAGES, given.code) ? given.code : 'failed';
  const error = { code, message: plainText(given.message) || DEFAULT_MESSAGES[code] };
  const hint = plainText(given.hint);
  if (hint) error.hint = hint;
  return { ok: false, error };
}

function readResult(output) {
  let found = null;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.type === 'result') found = parsed;
  }
  return found ? toResult(found) : failure('failed');
}

// Runs the adapter as a child process the way the contract says: workspace as the working
// directory, scrubbed environment, arguments as an array, one JSON request on stdin, one JSON
// line back. The server owns the deadline: at expiry the child is killed and the call reports
// "timeout".
function runAdapter({ command, cwd, request, timeoutMs, running, parse = readResult }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command[0], command.slice(1), { cwd, env: scrubbedEnv(), shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(failure('failed'));
      return;
    }
    // Kept until the process has really gone, so a server that is closing can wait for it.
    running.add(child);
    child.once('close', () => running.delete(child));
    let output = '';
    const finish = (result) => {
      clearTimeout(deadline);
      resolve(result);
    };
    const deadline = setTimeout(() => {
      child.kill();
      finish(failure('timeout'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > MAX_OUTPUT_LENGTH) {
        child.kill();
        finish(failure('failed'));
      }
    });
    child.on('error', () => finish(failure('failed')));
    child.on('close', () => finish(parse(output)));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

// The one factual line before the learner's words. An ordinary message says which page it came from.
// An answer to a free-text question says so and asks for a grade and a comment; the question id has
// already been checked to be plain.
function framing(kind, lesson, question) {
  if (kind === 'answer') {
    return `[user answer to freetext question${question ? ` ${question}` : ''} in ${lesson}, please grade and comment]`;
  }
  return `[sent from ${lesson}]`;
}

// resolveLesson turns the page's path into the workspace-relative lesson file, or null.
function createChat({
  workspace,
  adapter,
  resolveLesson,
  sendTimeoutMs = SEND_TIMEOUT_MS,
  resultTtlMs = RESULT_TTL_MS,
  running = new Set(),
  onSetupError = () => {},
}) {
  let session = null;
  // Results by message id: { status: 'pending' }, { status: 'done', result, doneAt } or, once
  // the reply has been collected, { status: 'fetched', doneAt } (kept so the id is never run again).
  const messages = new Map();
  // One queue per session identity: sends for a session run one at a time, and different
  // sessions run in parallel.
  const queues = new Map();

  // Never throws: whatever goes wrong becomes the message's result, so a queue cannot stall.
  async function run(id, identity, lesson, text, kind, question) {
    let result;
    try {
      // A message that was waiting when its conversation ended (the engine became unavailable, or
      // was primed again) is not sent into the old one.
      result = identity && identity === session
        ? await runAdapter({
            command: adapter,
            cwd: workspace,
            timeoutMs: sendTimeoutMs,
            running,
            request: { op: 'send', session: identity, lesson, text: `${framing(kind, lesson, question)}\n${text}` },
          })
        : failure('failed', 'Chat is not connected yet.');
    } catch {
      result = failure('failed');
    }
    messages.set(id, { status: 'done', result, doneAt: Date.now() });
    if (!result.ok && SETUP_CODES.has(result.error.code) && identity === session) onSetupError(result.error);
  }

  function dropExpired() {
    for (const [id, entry] of messages) {
      if (entry.status !== 'pending' && Date.now() - entry.doneAt > resultTtlMs) messages.delete(id);
    }
  }

  return {
    setSession(identity) {
      session = identity;
    },
    submit(body) {
      const lesson = typeof body.lesson === 'string' ? resolveLesson(body.lesson) : null;
      const valid =
        typeof body.id === 'string' && ID_PATTERN.test(body.id) &&
        typeof body.text === 'string' && body.text.length > 0 && body.text.length <= MAX_TEXT_LENGTH &&
        lesson &&
        (body.kind === undefined || (typeof body.kind === 'string' && KINDS.has(body.kind))) &&
        (body.question === undefined || (body.kind === 'answer' && typeof body.question === 'string' && ID_PATTERN.test(body.question)));
      if (!valid) return { status: 400, body: failure('failed', 'That message could not be sent.') };
      dropExpired();
      // A message id that is already known is never run twice.
      if (messages.has(body.id)) return { status: 202, body: { status: 'pending' } };

      const identity = session;
      const queue = queues.get(identity) || { outstanding: 0, tail: Promise.resolve() };
      if (queue.outstanding >= QUEUE_CAP) {
        return { status: 429, body: failure('failed', 'Too many messages are waiting. Wait for a reply, then try again.') };
      }
      queue.outstanding += 1;
      queues.set(identity, queue);
      messages.set(body.id, { status: 'pending' });
      queue.tail = queue.tail
        .then(() => run(body.id, identity, lesson, body.text, body.kind, body.question))
        .finally(() => {
          queue.outstanding -= 1;
          if (queue.outstanding === 0) queues.delete(identity);
        });
      return { status: 202, body: { status: 'pending' } };
    },
    // A finished reply is handed over once and then forgotten.
    lookup(id) {
      dropExpired();
      const entry = messages.get(id);
      if (!entry || entry.status === 'fetched') return { status: 'unknown' };
      if (entry.status === 'pending') return { status: 'pending' };
      messages.set(id, { status: 'fetched', doneAt: entry.doneAt });
      return { status: 'done', result: entry.result };
    },
    // Kills every adapter still running and waits until each has exited. It waits for the exit,
    // not for the output pipes to close: a grandchild holding a pipe must not stall the server.
    async close() {
      await Promise.all(
        [...running].map((child) => {
          if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
          const exited = new Promise((done) => child.once('exit', done));
          child.kill();
          return exited;
        }),
      );
    },
  };
}

module.exports = { createChat, runAdapter, failure, plainText, DEFAULT_MESSAGES };
