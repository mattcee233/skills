'use strict';
// The guide's table of scripts: every runnable script in bridge/ is named there with where it lives
// and when to run it, so an agent never has to guess which script does what.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEACH = path.join(__dirname, '..');
const BRIDGE = path.join(TEACH, 'bridge');
const guide = fs.readFileSync(path.join(TEACH, 'INTERACTIVE-SETUP.md'), 'utf8');
const section = guide.slice(guide.indexOf('## Scripts'), guide.indexOf('\n## ', guide.indexOf('## Scripts') + 1));

const runnable = fs
  .readdirSync(BRIDGE)
  .filter((name) => name.endsWith('.js'))
  .filter((name) => /^#!\/usr\/bin\/env node|require\.main === module/m.test(fs.readFileSync(path.join(BRIDGE, name), 'utf8')));

test('the guide has a Scripts section, and SKILL.md points to it', () => {
  assert.match(guide, /^## Scripts$/m);
  assert.match(fs.readFileSync(path.join(TEACH, 'SKILL.md'), 'utf8'), /INTERACTIVE-SETUP\.md#scripts/);
});

test('every runnable script in bridge/ is named in the Scripts section', () => {
  assert.ok(runnable.length >= 6, `found the runnable scripts: ${runnable.join(', ')}`);
  for (const name of runnable) {
    assert.ok(section.includes(name), `${name} is in the Scripts section`);
  }
});

test('the section says where scripts live and how to find that folder', () => {
  assert.match(section, /<skill>/);
  assert.match(section, /folder that holds `SKILL\.md`/);
  assert.match(section, /`<skill>\/bridge\//);
  assert.match(section, /`\.teach\/signal\.js`/);
});

test('the section tells setup.js and signal.js apart, and names the scripts the agent never runs', () => {
  assert.match(section, /setup\.js[^\n]*once per workspace/i);
  assert.match(section, /signal\.js[^\n]*copy/i);
  assert.match(section, /never run/i);
  assert.match(section, /serve\.js/);
});

test('every command the section lists is one the script handles', () => {
  const sources = Object.fromEntries(runnable.map((name) => [name, fs.readFileSync(path.join(BRIDGE, name), 'utf8')]));
  for (const [, script, commands] of section.matchAll(/`(setup|session|discovery|improvised|signal)\.js` \(commands?: ([^)]+)\)/g)) {
    const source = sources[`${script}.js`];
    for (const command of commands.split(',').map((c) => c.trim().replace(/`/g, ''))) {
      assert.ok(source.includes(`'${command}'`) || source.includes(`"${command}"`), `${script}.js handles "${command}"`);
    }
  }
});

test('the section says which lesson the link opens and how the first lesson is handled', () => {
  assert.match(section, /newest lesson[^\n]*by (its )?file name/i);
  assert.match(section, /--lesson/);
  assert.match(section, /write (the first lesson|lesson one|lesson 1)[^\n]*before[^\n]*start(ing)? the server/i);
  assert.match(section, /first lesson[^\n]*(needs no signal|no signal)/i);
});
