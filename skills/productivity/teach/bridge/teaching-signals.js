'use strict';
// The "Teaching signals" block that setup writes into the workspace AGENTS.md: the one place its
// text is made. The markers let a later run find the block and refresh it in place, and leave
// everything the learner wrote alone.
const BLOCK_START = '<!-- teach:signals:start (managed by /teach, refreshed when setup runs again) -->';
const BLOCK_END = '<!-- teach:signals:end -->';

const BLOCK_BODY = `## Teaching signals

The learner has these lessons open in a browser. When you change a lesson, tell the open page with the launcher in \`.teach/\`.

**Write the lesson file first, then signal.** The page is served from disk, so the file must be in its final state before you signal. A signal only nudges a page that is already open.

- A lesson you changed, that the learner may be reading: \`node .teach/signal.js reload lessons/<file>.html\`
- A new lesson for the learner to move on to: \`node .teach/signal.js next-lesson lessons/<file>.html "<lesson title>"\`

The lesson is a path from the workspace root. The title is plain text and becomes the label of the next-lesson button. Signal once per change. Signalling never moves the learner; they choose when to go on.

**If you cannot run the launcher** (you have no terminal, or it fails because the server is not reachable), write a file to \`.teach/signals/\` instead, with any unused name that ends in \`.json\`. Write it in one go, and only after the lesson file is done:

\`\`\`json
{"event": "next-lesson", "lesson": "lessons/<file>.html", "title": "<lesson title>"}
\`\`\`

Use \`"event": "reload"\` (no title needed) for a lesson you changed. The server picks the file up within a couple of seconds and deletes it.

**Never give away a quiz answer.** Do not state, hint at or confirm the answer to any quiz question on a page: not in your chat reply, not in the lesson text around the question, not when you revise a lesson ("the answer is still X", or a summary of what changed that names the right option), and not when you write the next lesson. If a revision changes a question or its options, say only that it changed. The page shows feedback when the learner presses Check; if they ask you for the answer, help them reason towards it instead.

**If \`.teach/signal.js\` is missing, do not signal at all.** Interactive teaching has not been set up in this copy of the workspace (or the workspace was cloned to a new machine), so no page is listening. Write the lesson as usual and mention that the learner can run \`/teach interactive\` to set it up.`;

const BLOCK = `${BLOCK_START}\n${BLOCK_BODY}\n${BLOCK_END}\n`;

function teachingSignalsBlock() {
  return BLOCK;
}

// Find the marked block: a start marker, then the first end marker after it. A start marker with
// no end (someone deleted half of it) is not a block, so the text after it is never swallowed.
function findBlock(text) {
  let from = 0;
  for (;;) {
    const end = text.indexOf(BLOCK_END, from);
    if (end === -1) return null;
    const start = text.lastIndexOf(BLOCK_START, end);
    if (start >= from) {
      const after = text[end + BLOCK_END.length] === '\n' ? end + BLOCK_END.length + 1 : end + BLOCK_END.length;
      return { start, end: after };
    }
    from = end + BLOCK_END.length;
  }
}

// The AGENTS.md text with the block added, or refreshed in place if it is already there.
function applyTeachingSignals(existing) {
  const text = typeof existing === 'string' ? existing : '';
  if (text === '') return BLOCK;
  const found = findBlock(text);
  if (found) return text.slice(0, found.start) + BLOCK + text.slice(found.end);
  const gap = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return text + gap + BLOCK;
}

module.exports = { teachingSignalsBlock, applyTeachingSignals, BLOCK_START, BLOCK_END };
