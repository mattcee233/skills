'use strict';
// The "Teaching signals" block that setup writes into the workspace AGENTS.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const { teachingSignalsBlock, applyTeachingSignals, BLOCK_START, BLOCK_END } = require('../bridge/teaching-signals');

test('the block is marked at both ends so a later run can find it', () => {
  const block = teachingSignalsBlock();
  assert.ok(block.startsWith(BLOCK_START));
  assert.ok(block.trimEnd().endsWith(BLOCK_END));
  assert.match(block, /^#+ Teaching signals$/m);
});

test('the block gives the exact commands the launcher takes', () => {
  const block = teachingSignalsBlock();
  assert.match(block, /node \.teach\/signal\.js next-lesson lessons\/\S+\.html "[^"]+"/);
  assert.match(block, /node \.teach\/signal\.js reload lessons\/\S+\.html/);
});

test('the block says to write the file first and signal after', () => {
  assert.match(teachingSignalsBlock(), /write (or update )?the (lesson )?file first/i);
});

test('the block describes the file drop fallback with its fields and folder', () => {
  const block = teachingSignalsBlock();
  assert.match(block, /\.teach\/signals\//);
  assert.match(block, /"event"/);
  assert.match(block, /"lesson"/);
  assert.match(block, /"title"/);
});

test('the block tells the agent not to signal when the launcher is missing', () => {
  const block = teachingSignalsBlock();
  assert.match(block, /\.teach\/signal\.js/);
  assert.match(block, /if [^.]*\.teach\/signal\.js[^.]*(is missing|does not exist)[^.]*(do not|don't|skip)[^.]*signal/i);
});

test('the block never suggests the token, and holds no em dashes', () => {
  const block = teachingSignalsBlock();
  assert.doesNotMatch(block, /token/i);
  assert.equal(block.includes('—'), false);
});

test('a file with no block gets one appended, and the learner\'s own text is untouched', () => {
  const mine = '# My notes\n\nRun the tests before you commit.\n';
  const result = applyTeachingSignals(mine);
  assert.ok(result.startsWith(mine));
  assert.ok(result.includes(teachingSignalsBlock()));
});

test('an empty or missing file gets just the block', () => {
  assert.equal(applyTeachingSignals(''), teachingSignalsBlock());
  assert.equal(applyTeachingSignals(null), teachingSignalsBlock());
});

test('a later run refreshes the block in place and leaves everything around it alone', () => {
  const before = 'Intro line.\n\n';
  const after = '\n## My other section\n\nStays put.\n';
  const stale = `${BLOCK_START}\nold text that no longer matches\n${BLOCK_END}\n`;

  const result = applyTeachingSignals(before + stale + after);

  assert.equal(result, before + teachingSignalsBlock() + after);
});

test('running it twice changes nothing the second time', () => {
  const once = applyTeachingSignals('# Notes\n');
  assert.equal(applyTeachingSignals(once), once);
});

test('a start marker with no end marker is not replaced blindly: the block is added and the stray text kept', () => {
  const broken = `Before.\n${BLOCK_START}\nsomething the learner wrote\n`;
  const result = applyTeachingSignals(broken);
  assert.ok(result.includes('something the learner wrote'));
  assert.ok(result.includes(teachingSignalsBlock()));
});

test('the block tells the chat agent never to reveal a quiz answer', () => {
  const block = teachingSignalsBlock();
  assert.match(block, /never (state|reveal|give away)[^.]*answer/i);
  // The cases that leak in practice: a revision summary, a new lesson, the surrounding text.
  assert.match(block, /revis/i);
  assert.match(block, /chat reply|your reply/i);
});

test('SKILL.md and QUIZ-FORMAT.md carry the same rule for the /teach agent', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['SKILL.md', 'QUIZ-FORMAT.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(text, /never (state|reveal|give away)[^.]*answer/i, `${file} says never to reveal an answer`);
  }
});

test('the block tells the chat agent what a free-text answer looks like and how to handle it', () => {
  const block = teachingSignalsBlock();
  assert.match(block, /\[user answer to freetext question/);
  assert.match(block, /grade/i);
  assert.match(block, /comment/i);
  // Grading one answer must not become a way to leak the others.
  assert.match(block, /other quiz questions|any other quiz/i);
});

test('QUIZ-FORMAT.md and LESSON-FORMAT.md show the free-text markup the widget reads', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['QUIZ-FORMAT.md', 'LESSON-FORMAT.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(text, /data-quiz-type="freetext"/, file + ' names the marker');
    assert.match(text, /<textarea/, file + ' shows the textarea');
    assert.match(text, /data-quiz-answer/, file + ' shows the hidden model answer');
  }
  const quizFormat = fs.readFileSync(path.join(__dirname, '..', 'QUIZ-FORMAT.md'), 'utf8');
  assert.match(quizFormat, /class="quiz-q" data-quiz-question="f1" data-quiz-type="freetext"/, 'it is a quiz-q like the others');
  assert.match(quizFormat, /data-quiz-check/, 'the lesson supplies the button');
  assert.doesNotMatch(quizFormat, /data-quiz-send/, 'there is no separate send button');
  assert.match(quizFormat, /sent to the teacher instead/i, 'says what the button does with chat live');
});
