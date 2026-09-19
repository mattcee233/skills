'use strict';
// Signals from the agent to an open page: what a valid one is, and the signal-file drop the server
// polls. The signal route and the file drop both go through checkSignal. Node built-ins only.
const fs = require('node:fs');
const path = require('node:path');

// What the agent may send. `displaced` and `lease-free` are also events on the page's stream, but
// the server makes those from the lease itself, so a signal cannot fake them.
const AGENT_EVENTS = new Set(['next-lesson', 'reload']);
const MAX_TITLE_LENGTH = 200;
const MAX_FILE_BYTES = 64 * 1024;

const refuse = (message) => ({ ok: false, message });

// One place says what a signal is. `resolveLesson` turns the lesson path the agent gave into the
// workspace-relative path of an existing lesson (like "lessons/0002-x.html"), or null.
function checkSignal(input, resolveLesson) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('A signal must be a JSON object.');
  const { event, lesson, title } = input;
  if (typeof event !== 'string' || !AGENT_EVENTS.has(event)) {
    return refuse('The event must be "next-lesson" or "reload".');
  }
  if (typeof lesson !== 'string' || lesson === '') {
    return refuse('A lesson path is required, such as "lessons/0002-recursion.html".');
  }
  const relative = resolveLesson(lesson);
  if (!relative) return refuse(`"${lesson}" is not an existing lesson in the workspace's lessons folder.`);
  const address = `/${relative.split('/').map(encodeURIComponent).join('/')}`;

  if (event === 'reload') return { ok: true, event, data: { lesson: address } };
  if (typeof title !== 'string' || !title.trim()) return refuse('A next-lesson signal needs a title for the button.');
  if (title.length > MAX_TITLE_LENGTH || /[\u0000-\u001f\u007f]/.test(title)) {
    return refuse(`The title must be plain text of up to ${MAX_TITLE_LENGTH} characters, on one line.`);
  }
  return { ok: true, event, data: { lesson: address, title: title.trim() } };
}

// Poll a folder of signal files: fire each valid one and delete it. A file that is refused is renamed
// to "<name>.rejected", so it is not read again but the mistake can be found. Polling, because file
// watching is unreliable on network shares.
function createSignalDrop({ dir, intervalMs = 1000, check, fire }) {
  // A file read while its writer is still busy will not parse yet: it gets one more tick.
  const unparsed = new Map();
  let timer = null;

  const reject = (file) => {
    try {
      fs.renameSync(file, `${file}.rejected`);
    } catch {
      fs.rmSync(file, { force: true });
    }
  };

  const take = (name) => {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return;
    }
    // A link is never followed, and nothing this big is a signal.
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return reject(file);

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (!(err instanceof SyntaxError)) return undefined;
      const tries = (unparsed.get(name) || 0) + 1;
      unparsed.set(name, tries);
      return tries >= 2 ? reject(file) : undefined;
    }
    unparsed.delete(name);

    const outcome = check(parsed);
    if (!outcome.ok) return reject(file);
    // Delete before firing: a file that cannot be deleted must not fire on every tick.
    try {
      fs.unlinkSync(file);
    } catch {
      return undefined;
    }
    return fire(outcome);
  };

  const tick = () => {
    let names;
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    } catch {
      unparsed.clear();
      return;
    }
    for (const name of unparsed.keys()) if (!names.includes(name)) unparsed.delete(name);
    for (const name of names) take(name);
  };

  return {
    start() {
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { checkSignal, createSignalDrop };
