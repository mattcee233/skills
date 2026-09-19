'use strict';
// The start-of-session handshake: `check` (no model turn), then `prime` (a paid, read-only
// turn), then the runtime conformance checks. It says which tier the session is in and holds
// the session identity, in memory only. Node built-ins only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runAdapter, plainText, DEFAULT_MESSAGES } = require('./chat');

const CHECK_TIMEOUT_MS = 20 * 1000;
const PRIME_TIMEOUT_MS = 5 * 60 * 1000;

const PRIME_INSTRUCTION =
  'You are the teacher for this learning workspace. In this turn only read: read MISSION.md, ' +
  'the learning records, the lesson named in "lesson" (if there is one) and the "Teaching signals" block in ' +
  'AGENTS.md. Do not change, create or delete anything, and do not run commands. Reply with one ' +
  'short acknowledgement. The learner will write to you shortly.';

// The workspace's files, as one hash. Left out: version control's folder, dependencies, and the
// two things the server itself keeps in its folder (its state file and the dropped signals). The
// rest of the server's folder is hashed, since that is where adapters live. Symbolic links are
// not followed. Reads are asynchronous so a large workspace never stalls the event stream.
const HASH_SKIPS = new Set(['.git', 'node_modules', '.teach/server.json', '.teach/signals']);

async function hashWorkspace(root) {
  const hash = crypto.createHash('sha256');
  const visit = async (dir, prefix) => {
    const entries = (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const relative = prefix + entry.name;
      if (HASH_SKIPS.has(relative) || (prefix === '' && HASH_SKIPS.has(entry.name))) continue;
      if (entry.isDirectory()) {
        await visit(path.join(dir, entry.name), relative + '/');
      } else if (entry.isFile()) {
        const content = crypto.createHash('sha256').update(await fs.promises.readFile(path.join(dir, entry.name))).digest('hex');
        hash.update(`${relative}
${content}
`);
      }
    }
  };
  await visit(root, '');
  return hash.digest('hex');
}

// The lesson the priming turn is told to read: the newest one on disk, or none yet.
function newestLesson(workspace) {
  try {
    const names = fs.readdirSync(path.join(workspace, 'lessons')).filter((name) => /.html?$/i.test(name)).sort();
    return names.length ? `lessons/${names.at(-1)}` : null;
  } catch {
    return null;
  }
}

const PRIME_WROTE_HINT = 'The connector changed files during its read-only start-up turn, so chat was switched off. Fix or replace the connector, then press Retry.';

const MALFORMED_HINT = 'The connector gave an answer the teaching server could not accept, so chat was switched off. Fix or replace the connector, then press Retry.';
const MAX_PERMISSIONS_LENGTH = 1000;
const MAX_SESSION_LENGTH = 256;

const INVALID = { invalid: true };

// Reads what a handshake call answered, strictly: this is the conformance check that every
// adapter, improvised ones included, must pass. Every non-empty line is a JSON object with a
// type tag; there is exactly one "result"; "progress" lines are allowed and ignored; an error
// has an allowed code, a plain-text message and, if present, a plain-text hint. Never throws.
// Answers { ok: true, ... }, { ok: false, error } or INVALID.
function parseFor(op) {
  return (output) => {
    const results = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return INVALID;
      }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return INVALID;
      if (parsed.type === 'result') results.push(parsed);
    }
    if (results.length !== 1) return INVALID;
    const [result] = results;

    if (result.ok === false) {
      const given = result.error;
      if (!given || typeof given !== 'object' || !Object.hasOwn(DEFAULT_MESSAGES, given.code)) return INVALID;
      const message = plainText(given.message);
      if (!message) return INVALID;
      const error = { code: given.code, message };
      if (given.hint !== undefined) {
        const hint = plainText(given.hint);
        if (!hint) return INVALID;
        error.hint = hint;
      }
      return { ok: false, error };
    }
    if (result.ok !== true) return INVALID;
    if (op === 'check') {
      const permissions = plainText(result.permissions, MAX_PERMISSIONS_LENGTH);
      return permissions ? { ok: true, permissions } : INVALID;
    }
    const session = result.session;
    // Opaque to the server: any non-empty string of sensible length with no control characters.
    const usable = typeof session === 'string' && session.length > 0 && session.length <= MAX_SESSION_LENGTH && [...session].every((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127);
    return usable ? { ok: true, session } : INVALID;
  };
}

// Before it has run, a handshake is pending. Without an adapter there is nothing to test, and a
// session identity given up front (tests, the dev harness) counts as already connected.
function initialState(adapter, session) {
  if (!adapter) return { state: 'static', generation: 0, reason: 'no-adapter', message: 'No connector is set up for this workspace.' };
  if (session) return { state: 'interactive', generation: 1 };
  return { state: 'pending', generation: 0 };
}

function createHandshake({ workspace, adapter, session = null, running, setSession, broadcast, checkTimeoutMs = CHECK_TIMEOUT_MS, primeTimeoutMs = PRIME_TIMEOUT_MS }) {
  let state = initialState(adapter, session);

  function publish(next) {
    state = next;
    broadcast('handshake', state);
  }

  function unavailable(error) {
    const next = { state: 'static', generation: state.generation, reason: error.code, message: error.message };
    const hint = plainText(error.hint);
    if (hint) next.hint = hint;
    publish(next);
  }

  function refuse(hint) {
    publish({ state: 'static', generation: state.generation, reason: 'conformance', message: 'The teacher connection failed its safety check.', hint });
  }

  let stopped = false;
  const call = (request, timeoutMs) => stopped ? Promise.resolve(INVALID) : runAdapter({ command: adapter, cwd: workspace, request, timeoutMs, running, parse: parseFor(request.op) });

  // Runs check, then prime. A failed check skips the paid prime. Whatever goes wrong becomes a
  // state, never a throw.
  async function attempt() {
    const checked = await call({ op: 'check' }, checkTimeoutMs);
    if (checked.invalid) return refuse(MALFORMED_HINT);
    if (!checked.ok) return unavailable(checked.error);
    const before = await hashWorkspace(workspace);
    const primed = await call({ op: 'prime', lesson: newestLesson(workspace), instruction: PRIME_INSTRUCTION }, primeTimeoutMs);
    // A priming turn must not have changed anything, whatever it then reported.
    if ((await hashWorkspace(workspace)) !== before) return refuse(PRIME_WROTE_HINT);
    if (primed.invalid) return refuse(MALFORMED_HINT);
    if (!primed.ok) return unavailable(primed.error);
    setSession(primed.session);
    return publish({ state: 'interactive', generation: state.generation + 1, permissions: checked.permissions });
  }

  async function run() {
    try {
      await attempt();
    } catch {
      publish({ state: 'error', generation: state.generation, message: 'The connection test could not finish.', hint: 'Press Retry to test it again.' });
    }
  }

  return {
    get state() {
      return state;
    },
    start() {
      return state.state === 'pending' ? run() : Promise.resolve();
    },
    // The engine failed in a way only the learner can fix: chat falls back to not connected, and
    // Retry runs check and a new prime.
    markUnavailable(error) {
      if (state.state !== 'interactive') return;
      setSession(null);
      unavailable(error);
    },
    // The server is closing: no adapter is started from here on.
    stop() {
      stopped = true;
    },
    // Test again after a failure. A test that is already running is left to finish, and a session
    // that is already interactive is left alone (priming is a paid turn).
    retry() {
      if (!adapter || state.state === 'pending' || state.state === 'interactive') return Promise.resolve();
      publish({ state: 'pending', generation: state.generation });
      return run();
    },
  };
}

module.exports = { createHandshake };
