'use strict';
// Shared by the signalling tests: a small workspace and every way a signal can be wrong.
const os = require('node:os');
const path = require('node:path');

const LESSON = '<!doctype html><html><body><h1>Loops</h1></body></html>';

const SIGNAL_FILES = {
  'MISSION.md': 'Learn loops.',
  'lessons/0001-loops.html': LESSON,
  'lessons/0002-recursion.html': LESSON,
  'notes/private.html': LESSON,
};

// Every way a signal can be wrong. The signal route, the signal file drop and the launcher must
// each refuse every one.
const BAD_SIGNALS = {
  'an unknown event': { event: 'explode', lesson: 'lessons/0001-loops.html' },
  'no event': { lesson: 'lessons/0001-loops.html' },
  'a missing lesson': { event: 'reload', lesson: 'lessons/0099-missing.html' },
  'no lesson': { event: 'reload' },
  'a path outside the workspace': { event: 'reload', lesson: '../outside.html' },
  'an absolute path elsewhere': { event: 'reload', lesson: path.resolve(os.tmpdir(), 'x.html') },
  'a workspace file that is not a lesson': { event: 'reload', lesson: 'MISSION.md' },
  'a page outside the lessons folder': { event: 'reload', lesson: 'notes/private.html' },
  'a next lesson with no title': { event: 'next-lesson', lesson: 'lessons/0002-recursion.html' },
  'a lease event the server makes itself': { event: 'displaced' },
};

module.exports = { LESSON, SIGNAL_FILES, BAD_SIGNALS };
