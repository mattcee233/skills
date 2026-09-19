'use strict';
// Lesson-authoring guidance and hooks for /teach lessons.
// Verifies ticket 28: lessons carry the stable next-lesson hook, quiz hook, and
// reminder wording, open cleanly as plain files, update in place, and signal
// reload or next-lesson after writing to disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REMINDER_TEXT,
  NEXT_LESSON_ATTR,
  formatNextLessonHook,
  renderLesson,
  upsertNextLessonButton,
} = require('../bridge/lesson');
const { teachingSignalsBlock } = require('../bridge/teaching-signals');

const TEACH_DIR = path.join(__dirname, '..');
const SKILL_MD_PATH = path.join(TEACH_DIR, 'SKILL.md');
const LESSON_FORMAT_PATH = path.join(TEACH_DIR, 'LESSON-FORMAT.md');
const QUIZ_FORMAT_PATH = path.join(TEACH_DIR, 'QUIZ-FORMAT.md');

test('REMINDER_TEXT has the exact wording that is true in every tier', () => {
  assert.equal(
    REMINDER_TEXT,
    'Ask in the chat panel if you see one, or ask me in this conversation.'
  );
});

test('NEXT_LESSON_ATTR is data-teach-next', () => {
  assert.equal(NEXT_LESSON_ATTR, 'data-teach-next');
});

test('formatNextLessonHook produces a clean HTML anchor with data-teach-next and class teach-next', () => {
  const hook = formatNextLessonHook('0002-lists.html', 'Working with Lists');
  assert.equal(
    hook,
    '<a href="0002-lists.html" class="teach-next" data-teach-next>Next lesson: Working with Lists</a>'
  );
});

test('renderLesson generates a clean lesson with next-lesson hook, reminder wording, and quiz hook', () => {
  const html = renderLesson({
    title: 'Loops and Iteration',
    number: '0001',
    slug: 'loops-and-iteration',
    explanation: '<p>A loop repeats a sequence of statements until a condition is met.</p>',
    citations: ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Loops_and_iteration'],
    quiz: {
      id: 'q1',
      question: 'Which statement immediately exits a loop in JavaScript?',
      options: [
        { label: 'return statement', value: 'a' },
        { label: 'break statement', value: 'b', correct: true },
        { label: 'continue statement', value: 'c' },
      ],
    },
    nextLesson: {
      href: '0002-nested-loops.html',
      title: 'Nested Loops',
    },
  });

  // Self-contained HTML opening cleanly as a plain file
  assert.match(html, /^<!doctype html>\s*<html/i);
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /<meta name="viewport"/i);
  assert.match(html, /<title>Loops and Iteration<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/assets\/style\.css">/);

  // Contains the next-lesson hook
  assert.match(html, /<a href="0002-nested-loops\.html" class="teach-next" data-teach-next>Next lesson: Nested Loops<\/a>/);

  // Contains the reminder wording
  assert.ok(html.includes('Ask in the chat panel if you see one, or ask me in this conversation.'));

  // Contains the quiz hook conforming to QUIZ-FORMAT.md
  assert.match(html, /data-quiz-question="q1"/);
  assert.match(html, /<input type="radio" name="q1" value="b" data-correct>/);
  assert.match(html, /data-quiz-check/);
  assert.match(html, /data-quiz-feedback/);

  // Has no hardcoded localhost or server scripts that break when opened offline
  assert.doesNotMatch(html, /http:\/\/127\.0\.0\.1/);
  assert.doesNotMatch(html, /http:\/\/localhost/);
  assert.doesNotMatch(html, /widget\.js/); // widget is injected by the server, not baked into disk
});

test('renderLesson without a next lesson yet provides a placeholder or omits until created', () => {
  const html = renderLesson({
    title: 'Lesson 1',
    number: '0001',
    slug: 'lesson-one',
    explanation: '<p>Content</p>',
  });

  assert.ok(html.includes('Ask in the chat panel if you see one, or ask me in this conversation.'));
  assert.match(html, /^<!doctype html>/i);
});

test('upsertNextLessonButton updates existing hook on disk or adds it if missing', () => {
  const initial = `<!doctype html>
<html><head><title>Test</title></head>
<body>
<h1>Test</h1>
<p>Content</p>
<a href="0002-old.html" class="teach-next" data-teach-next>Next lesson: Old Title</a>
</body></html>`;

  const updated = upsertNextLessonButton(initial, '0002-new.html', 'New Title');
  assert.match(updated, /<a href="0002-new\.html" class="teach-next" data-teach-next>Next lesson: New Title<\/a>/);
  assert.doesNotMatch(updated, /Old Title/);

  // If page had no next button yet:
  const withoutButton = `<!doctype html>
<html><head><title>Test</title></head>
<body>
<h1>Test</h1>
<p>Content</p>
</body></html>`;

  const added = upsertNextLessonButton(withoutButton, '0002-new.html', 'New Title');
  assert.match(added, /<a href="0002-new\.html" class="teach-next" data-teach-next>Next lesson: New Title<\/a>/);
  assert.ok(added.includes('</body>'));
});

test('LESSON-FORMAT.md exists and documents the complete lesson-authoring guidance', () => {
  assert.ok(fs.existsSync(LESSON_FORMAT_PATH), 'LESSON-FORMAT.md must exist');
  const content = fs.readFileSync(LESSON_FORMAT_PATH, 'utf8');

  // Next-lesson hook documented
  assert.match(content, /data-teach-next/);
  assert.match(content, /teach-next/);

  // Reminder wording documented verbatim
  assert.ok(
    content.includes('Ask in the chat panel if you see one, or ask me in this conversation.'),
    'LESSON-FORMAT.md must include the exact follow-up reminder text'
  );

  // Quiz markup hook documented and links QUIZ-FORMAT.md
  assert.match(content, /QUIZ-FORMAT\.md/);
  assert.match(content, /data-quiz-question/);
  assert.match(content, /data-quiz-check/);

  // Write-the-file-first rule
  assert.match(
    content,
    /write (the )?(lesson )?file first/i,
    'LESSON-FORMAT.md must state write file first and signal second'
  );

  // Update in place rule (never tag revisions)
  assert.match(
    content,
    /update (the )?lesson(s)? in place/i,
    'LESSON-FORMAT.md must state to update lessons in place'
  );
  assert.match(
    content,
    /(never|do not) (tag|create|use) (with )?revision/i,
    'LESSON-FORMAT.md must state never tag with revisions'
  );

  // Names the two events: reload and next-lesson, consistent with teaching signals
  assert.match(content, /`reload`/);
  assert.match(content, /`next-lesson`/);
  assert.match(content, /node \.teach\/signal\.js reload/);
  assert.match(content, /node \.teach\/signal\.js next-lesson/);

  // Plain file / clean opening
  assert.match(content, /plain file/i);
});

test('SKILL.md links LESSON-FORMAT.md, QUIZ-FORMAT.md, and INTERACTIVE-SETUP.md without inlining', () => {
  const content = fs.readFileSync(SKILL_MD_PATH, 'utf8');

  // Links LESSON-FORMAT.md
  assert.match(content, /\[LESSON-FORMAT\.md\]\(\.\/LESSON-FORMAT\.md\)/);

  // Links QUIZ-FORMAT.md
  assert.match(content, /\[QUIZ-FORMAT\.md\]\(\.\/QUIZ-FORMAT\.md\)/);

  // Links INTERACTIVE-SETUP.md
  assert.match(content, /\[INTERACTIVE-SETUP\.md\]\(\.\/INTERACTIVE-SETUP\.md\)/);

  // States the follow-up reminder wording verbatim
  assert.ok(
    content.includes('Ask in the chat panel if you see one, or ask me in this conversation.'),
    'SKILL.md must include the exact follow-up reminder text'
  );

  // States write file first, signal second, and update in place
  assert.match(content, /write (the )?(lesson )?file first/i);
  assert.match(content, /update (the )?lesson(s)? in place/i);

  // Names the two events
  assert.match(content, /`reload`/);
  assert.match(content, /`next-lesson`/);
});
