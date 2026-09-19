'use strict';
// The change meets the repo's conventions: `teach` stays user-invoked only, its docs page keeps
// the four fixed sections and covers interactive mode, and the READMEs and plugin manifest still
// list it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
// The skill folder ships with installs of the skill, without the repo around it: skip there.
const inRepo = fs.existsSync(path.join(REPO, 'docs', 'productivity', 'teach.md'));
const repoTest = inRepo ? test : test.skip;
const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');

repoTest('teach is still user-invoked only', () => {
  assert.match(read('skills', 'productivity', 'teach', 'SKILL.md'), /^disable-model-invocation: true$/m);
  assert.match(read('skills', 'productivity', 'teach', 'agents', 'openai.yaml'), /allow_implicit_invocation: false/);
});

repoTest('the docs page has the four fixed sections in order, and covers interactive mode', () => {
  const page = read('docs', 'productivity', 'teach.md');
  const headings = [...page.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const fixed = ['What it does', 'When to reach for it', 'Common questions', "It's working if"];
  assert.deepEqual(headings.filter((h) => fixed.includes(h)), fixed);
  assert.doesNotMatch(page, /^# /m, 'no H1');
  assert.doesNotMatch(page, /\u2014/, 'no em-dashes');
  for (const topic of [/three tiers/i, /amber notice/i, /other devices/i, /\/teach interactive/, /Chat not connected/, /usage limit/i]) {
    assert.match(page, topic);
  }
  const links = [...page.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.every((link) => /^https:\/\//.test(link)), 'every link is absolute');
});

repoTest('teach is still listed in the READMEs and the plugin manifest', () => {
  assert.match(read('README.md'), /\[teach\]\(\.\/skills\/productivity\/teach\/SKILL\.md\)/);
  assert.match(read('skills', 'productivity', 'README.md'), /\[teach\]\(\.\/teach\/SKILL\.md\)/);
  assert.ok(JSON.parse(read('.claude-plugin', 'plugin.json')).skills.includes('./skills/productivity/teach'));
});
