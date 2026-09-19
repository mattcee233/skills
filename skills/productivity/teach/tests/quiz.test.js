'use strict';
// Quiz persistence and markup hook tests.
// Verifies that a learner's quiz selections and checked feedback survive reloads
// and lesson revisions, stored per-lesson in localStorage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A lightweight DOM simulator for testing widget.js quiz logic without browser dependencies.
function createDomEnvironment({ pathname = '/lessons/0001-intro.html', html = '' } = {}) {
  const listeners = new Map();
  const storage = new Map();

  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
    _raw: storage,
  };

  class Node {
    constructor(tagName = '', attributes = {}) {
      this.tagName = tagName.toUpperCase();
      this.nodeType = 1;
      this.attributes = { ...attributes };
      this.children = [];
      this.parentNode = null;
      this._textContent = '';
      this.checked = false;
      this.type = attributes.type || '';
      this.name = attributes.name || '';
      this.value = attributes.value || '';
      this.className = attributes.class || '';
    }

    get textContent() {
      if (this.children.length > 0) {
        return this.children.map((c) => c.textContent).join('');
      }
      return this._textContent;
    }

    set textContent(val) {
      this.children = [];
      this._textContent = String(val);
    }

    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }

    setAttribute(name, val) {
      this.attributes[name] = String(val);
      if (name === 'class') this.className = String(val);
      if (name === 'value') this.value = String(val);
      if (name === 'name') this.name = String(val);
      if (name === 'type') this.type = String(val);
    }

    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    }

    removeAttribute(name) {
      delete this.attributes[name];
      if (name === 'class') this.className = '';
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }

    closest(selector) {
      let curr = this;
      while (curr) {
        if (curr.matches && curr.matches(selector)) return curr;
        curr = curr.parentNode;
      }
      return null;
    }

    matches(selector) {
      // Basic selector matcher for compound selectors like .quiz-q[data-i="0"]
      const parts = selector.split(',').map((s) => s.trim());
      for (const sel of parts) {
        let remaining = sel;
        let matched = true;

        // Tag name check
        const tagMatch = /^([a-zA-Z0-9-]+)/.exec(remaining);
        if (tagMatch && !remaining.startsWith('.') && !remaining.startsWith('[')) {
          if (this.tagName !== tagMatch[1].toUpperCase()) continue;
          remaining = remaining.slice(tagMatch[1].length);
        }

        // Parse remaining classes and attributes
        while (remaining.length > 0) {
          if (remaining.startsWith('.')) {
            const clsMatch = /^\.([a-zA-Z0-9_-]+)/.exec(remaining);
            if (!clsMatch) { matched = false; break; }
            if (!this.className.split(/\s+/).includes(clsMatch[1])) { matched = false; break; }
            remaining = remaining.slice(clsMatch[0].length);
          } else if (remaining.startsWith('[')) {
            const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:=([^\]]+))?\]/.exec(remaining);
            if (!attrMatch) { matched = false; break; }
            const attrName = attrMatch[1];
            const attrVal = attrMatch[2] ? attrMatch[2].replace(/^["']|["']$/g, '').trim() : null;
            if (!this.hasAttribute(attrName)) { matched = false; break; }
            if (attrVal !== null && this.getAttribute(attrName) !== attrVal) { matched = false; break; }
            remaining = remaining.slice(attrMatch[0].length);
          } else {
            matched = false;
            break;
          }
        }

        if (matched) return true;
      }
      return false;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
      const results = [];
      function walk(node) {
        for (const child of node.children) {
          if (child.matches && child.matches(selector)) {
            results.push(child);
          }
          walk(child);
        }
      }
      walk(this);
      return results;
    }
  }

  // Parse a minimal HTML subset for tests
  function parseSimpleHtml(markup) {
    const root = new Node('BODY');
    // Regex-based simple parser for testing structures
    // Matches tags: <tag attrs> or text
    const tagRegex = /<(\/)?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
    const stack = [root];
    let match;

    while ((match = tagRegex.exec(markup)) !== null) {
      const [full, isClose, tagName, attrStr, text] = match;
      if (text) {
        const trimmed = text.trim();
        if (trimmed) {
          const textNode = new Node('#text');
          textNode.textContent = trimmed;
          stack[stack.length - 1].appendChild(textNode);
        }
      } else if (isClose) {
        if (stack.length > 1 && stack[stack.length - 1].tagName === tagName.toUpperCase()) {
          stack.pop();
        }
      } else {
        const attrs = {};
        if (attrStr) {
          const attrRegex = /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
          let aMatch;
          while ((aMatch = attrRegex.exec(attrStr)) !== null) {
            attrs[aMatch[1]] = aMatch[2] !== undefined ? aMatch[2] : (aMatch[3] !== undefined ? aMatch[3] : (aMatch[4] || ''));
          }
        }
        const node = new Node(tagName, attrs);
        stack[stack.length - 1].appendChild(node);
        // void tags don't get pushed
        if (!['INPUT', 'IMG', 'BR', 'HR'].includes(node.tagName)) {
          stack.push(node);
        }
      }
    }
    return root;
  }

  const document = {
    body: parseSimpleHtml(html),
    documentElement: new Node('HTML'),
    createElement(tag) {
      return new Node(tag);
    },
    createTextNode(text) {
      const n = new Node('#text');
      n.textContent = text;
      return n;
    },
    querySelector(selector) {
      if (selector === '#teach-widget') return document.body.querySelector('#teach-widget');
      return document.body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return document.body.querySelectorAll(selector);
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      if (!listeners.has(type)) return;
      const arr = listeners.get(type).filter((h) => h !== handler);
      listeners.set(type, arr);
    },
    dispatchEvent(event) {
      const arr = listeners.get(event.type) || [];
      for (const h of arr) h(event);
      return true;
    },
    title: 'Test Lesson',
    readyState: 'complete',
  };

  const window = {
    location: {
      pathname,
      search: '',
      hash: '',
    },
    localStorage,
    sessionStorage: localStorage,
    addEventListener(type, handler) {
      document.addEventListener(type, handler);
    },
    removeEventListener(type, handler) {
      document.removeEventListener(type, handler);
    },
    document,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail || {};
      }
    },
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
  };

  return { window, document, localStorage };
}

// Load widget.js inside the simulated DOM environment
function loadWidget(domEnv) {
  const widgetSource = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'widget', 'widget.js'), 'utf8');
  const context = vm.createContext({
    window: domEnv.window,
    document: domEnv.document,
    location: domEnv.window.location,
    localStorage: domEnv.localStorage,
    sessionStorage: domEnv.localStorage,
    CustomEvent: domEnv.window.CustomEvent,
    Event: domEnv.window.Event,
    URLSearchParams: globalThis.URLSearchParams,
    DOMParser: class DOMParser {},
    setTimeout: () => {},
    clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: false }),
    crypto: { getRandomValues: (b) => b },
    console,
  });
  vm.runInContext(widgetSource, context);
  return domEnv;
}

const SAMPLE_QUIZ_HTML = `
<div class="lesson-content">
  <h1>Sample Lesson</h1>
  <div data-quiz-question="q1" data-correct="b">
    <p>What is Git?</p>
    <ul>
      <li><label><input type="radio" name="q1" value="a"> An editor.</label></li>
      <li><label><input type="radio" name="q1" value="b"> A version control system.</label></li>
      <li><label><input type="radio" name="q1" value="c"> A compiler.</label></li>
    </ul>
    <button type="button" data-quiz-check>Check</button>
    <p data-quiz-feedback class="fb"></p>
  </div>
  <div data-quiz-question="q2">
    <p>What is a branch?</p>
    <ul>
      <li><label><input type="radio" name="q2" value="x" data-correct> A pointer to a commit.</label></li>
      <li><label><input type="radio" name="q2" value="y"> A copy of every file.</label></li>
    </ul>
    <button type="button" data-quiz-check>Check</button>
    <p data-quiz-feedback class="fb"></p>
  </div>
</div>
`;

test('selecting and checking answers saves state per lesson in localStorage', () => {
  const dom = createDomEnvironment({ pathname: '/lessons/0001-loops.html', html: SAMPLE_QUIZ_HTML });
  loadWidget(dom);

  const q1 = dom.document.querySelector('[data-quiz-question="q1"]');
  const optionB = q1.querySelector('input[value="b"]');
  const checkBtn = q1.querySelector('[data-quiz-check]');
  const feedback = q1.querySelector('[data-quiz-feedback]');

  // Select option B
  optionB.checked = true;
  dom.document.dispatchEvent({ type: 'change', target: optionB });

  // Checked should be false before clicking check
  const stateAfterSelect = JSON.parse(dom.localStorage.getItem('teach.quiz:/lessons/0001-loops.html'));
  assert.equal(stateAfterSelect.q1.selected, 'b');
  assert.equal(stateAfterSelect.q1.checked, false);
  assert.equal(feedback.textContent, '');

  // Click Check button
  dom.document.dispatchEvent({ type: 'click', target: checkBtn });

  const stateAfterCheck = JSON.parse(dom.localStorage.getItem('teach.quiz:/lessons/0001-loops.html'));
  assert.equal(stateAfterCheck.q1.selected, 'b');
  assert.equal(stateAfterCheck.q1.checked, true);
  assert.equal(feedback.textContent, 'Correct.');
  assert.ok(feedback.className.includes('ok'));
});

test('reloading restores selections and shown feedback from localStorage', () => {
  const initialDom = createDomEnvironment({ pathname: '/lessons/0001-loops.html', html: SAMPLE_QUIZ_HTML });
  loadWidget(initialDom);

  const q1 = initialDom.document.querySelector('[data-quiz-question="q1"]');
  const optionB = q1.querySelector('input[value="b"]');
  const checkBtn = q1.querySelector('[data-quiz-check]');

  optionB.checked = true;
  initialDom.document.dispatchEvent({ type: 'change', target: optionB });
  initialDom.document.dispatchEvent({ type: 'click', target: checkBtn });

  // Simulate fresh page reload sharing the same localStorage
  const freshDom = createDomEnvironment({ pathname: '/lessons/0001-loops.html', html: SAMPLE_QUIZ_HTML });
  // Copy localStorage from initial
  for (const [k, v] of initialDom.localStorage._raw.entries()) {
    freshDom.localStorage.setItem(k, v);
  }

  loadWidget(freshDom);

  const restoredQ1 = freshDom.document.querySelector('[data-quiz-question="q1"]');
  const restoredInput = restoredQ1.querySelector('input[value="b"]');
  const restoredFeedback = restoredQ1.querySelector('[data-quiz-feedback]');

  assert.equal(restoredInput.checked, true, 'selected answer should be restored');
  assert.equal(restoredFeedback.textContent, 'Correct.', 'feedback text should be restored');
  assert.ok(restoredFeedback.className.includes('ok'), 'feedback class should be restored');
});

test('a reload signal keeps stored answers for unchanged questions and does not error for removed ones', () => {
  const dom = createDomEnvironment({ pathname: '/lessons/0001-loops.html', html: SAMPLE_QUIZ_HTML });
  loadWidget(dom);

  const q1 = dom.document.querySelector('[data-quiz-question="q1"]');
  const q2 = dom.document.querySelector('[data-quiz-question="q2"]');

  // Answer q1
  const optionB = q1.querySelector('input[value="b"]');
  optionB.checked = true;
  dom.document.dispatchEvent({ type: 'change', target: optionB });
  dom.document.dispatchEvent({ type: 'click', target: q1.querySelector('[data-quiz-check]') });

  // Answer q2
  const optionX = q2.querySelector('input[value="x"]');
  optionX.checked = true;
  dom.document.dispatchEvent({ type: 'change', target: optionX });
  dom.document.dispatchEvent({ type: 'click', target: q2.querySelector('[data-quiz-check]') });

  // Revise lesson: q2 is removed, q1 is kept, new q3 added
  const revisedHtml = `
  <div class="lesson-content">
    <h1>Sample Lesson Revised</h1>
    <div data-quiz-question="q1" data-correct="b">
      <p>What is Git? (revised wording)</p>
      <ul>
        <li><label><input type="radio" name="q1" value="a"> An editor.</label></li>
        <li><label><input type="radio" name="q1" value="b"> A version control system.</label></li>
      </ul>
      <button type="button" data-quiz-check>Check</button>
      <p data-quiz-feedback class="fb"></p>
    </div>
    <div data-quiz-question="q3" data-correct="z">
      <p>What is a tag?</p>
      <ul>
        <li><label><input type="radio" name="q3" value="z"> Fixed marker.</label></li>
      </ul>
      <button type="button" data-quiz-check>Check</button>
      <p data-quiz-feedback class="fb"></p>
    </div>
  </div>
  `;

  // Replace body with revised markup
  dom.document.body = createDomEnvironment({ html: revisedHtml }).document.body;

  // Dispatch teach:lesson-updated event (fired by swapLesson on reload signal)
  assert.doesNotThrow(() => {
    dom.document.dispatchEvent(new dom.window.CustomEvent('teach:lesson-updated'));
  });

  // q1 answers should be restored
  const revisedQ1 = dom.document.querySelector('[data-quiz-question="q1"]');
  assert.equal(revisedQ1.querySelector('input[value="b"]').checked, true);
  assert.equal(revisedQ1.querySelector('[data-quiz-feedback]').textContent, 'Correct.');

  // q3 has no stored answer
  const q3 = dom.document.querySelector('[data-quiz-question="q3"]');
  assert.equal(q3.querySelector('input[value="z"]').checked, false);
});

test('answers are stored per lesson, so two lessons never share state', () => {
  const dom1 = createDomEnvironment({ pathname: '/lessons/0001-loops.html', html: SAMPLE_QUIZ_HTML });
  loadWidget(dom1);

  const q1 = dom1.document.querySelector('[data-quiz-question="q1"]');
  const optionB = q1.querySelector('input[value="b"]');
  optionB.checked = true;
  dom1.document.dispatchEvent({ type: 'change', target: optionB });
  dom1.document.dispatchEvent({ type: 'click', target: q1.querySelector('[data-quiz-check]') });

  // Open second lesson with same storage
  const dom2 = createDomEnvironment({ pathname: '/lessons/0002-lists.html', html: SAMPLE_QUIZ_HTML });
  for (const [k, v] of dom1.localStorage._raw.entries()) {
    dom2.localStorage.setItem(k, v);
  }
  loadWidget(dom2);

  const q1Lesson2 = dom2.document.querySelector('[data-quiz-question="q1"]');
  assert.equal(q1Lesson2.querySelector('input[value="b"]').checked, false, 'lesson 2 should not have lesson 1 selection');
  assert.equal(q1Lesson2.querySelector('[data-quiz-feedback]').textContent, '', 'lesson 2 should not have lesson 1 feedback');

  // Key in localStorage for lesson 1 exists, but not for lesson 2
  assert.ok(dom2.localStorage.getItem('teach.quiz:/lessons/0001-loops.html'));
  assert.equal(dom2.localStorage.getItem('teach.quiz:/lessons/0002-lists.html'), null);
});

test('a lesson with no quiz, or a quiz not following the hook, degrades to no persistence without errors', () => {
  const noQuizHtml = `<h1>No Quiz Here</h1><p>Plain text lesson.</p>`;
  const domNoQuiz = createDomEnvironment({ pathname: '/lessons/0003-plain.html', html: noQuizHtml });
  assert.doesNotThrow(() => loadWidget(domNoQuiz));

  const badQuizHtml = `<div class="some-random-div"><button>Not a real quiz</button></div>`;
  const domBadQuiz = createDomEnvironment({ pathname: '/lessons/0004-bad.html', html: badQuizHtml });
  assert.doesNotThrow(() => loadWidget(domBadQuiz));

  // Clicking random button does not throw
  assert.doesNotThrow(() => {
    domBadQuiz.document.dispatchEvent({ type: 'click', target: domBadQuiz.document.querySelector('button') });
  });
});

test('checking an incorrect answer shows incorrect feedback and persists checked state', () => {
  const dom = createDomEnvironment({ pathname: '/lessons/0001-loops.html', html: SAMPLE_QUIZ_HTML });
  loadWidget(dom);

  const q1 = dom.document.querySelector('[data-quiz-question="q1"]');
  const optionA = q1.querySelector('input[value="a"]');
  const checkBtn = q1.querySelector('[data-quiz-check]');
  const feedback = q1.querySelector('[data-quiz-feedback]');

  optionA.checked = true;
  dom.document.dispatchEvent({ type: 'change', target: optionA });
  dom.document.dispatchEvent({ type: 'click', target: checkBtn });

  assert.equal(feedback.textContent, 'Not quite: have another look.');
  assert.ok(feedback.className.includes('no'));

  const saved = JSON.parse(dom.localStorage.getItem('teach.quiz:/lessons/0001-loops.html'));
  assert.equal(saved.q1.selected, 'a');
  assert.equal(saved.q1.checked, true);

  // Changing answer clears feedback
  const optionC = q1.querySelector('input[value="c"]');
  optionC.checked = true;
  dom.document.dispatchEvent({ type: 'change', target: optionC });
  assert.equal(feedback.textContent, '');
  assert.ok(!feedback.className.includes('no'));
});

test('supports prototype-style markup (.quiz-q, data-i, data-check, .fb)', () => {
  const prototypeHtml = `
    <section class="quiz">
      <div class="quiz-q" data-i="0" data-correct="b">
        <p>Question 1</p>
        <ul>
          <li><label><input type="radio" name="q0" value="a"> A</label></li>
          <li><label><input type="radio" name="q0" value="b"> B</label></li>
        </ul>
        <button type="button" data-check>Check</button>
        <p class="fb"></p>
      </div>
    </section>
  `;
  const dom = createDomEnvironment({ pathname: '/lessons/0001-prototype.html', html: prototypeHtml });
  loadWidget(dom);

  const q0 = dom.document.querySelector('.quiz-q[data-i="0"]');
  const optionB = q0.querySelector('input[value="b"]');
  optionB.checked = true;
  dom.document.dispatchEvent({ type: 'change', target: optionB });
  dom.document.dispatchEvent({ type: 'click', target: q0.querySelector('[data-check]') });

  assert.equal(q0.querySelector('.fb').textContent, 'Correct.');
  assert.ok(q0.querySelector('.fb').className.includes('ok'));

  const saved = JSON.parse(dom.localStorage.getItem('teach.quiz:/lessons/0001-prototype.html'));
  assert.equal(saved['0'].selected, 'b');
  assert.equal(saved['0'].checked, true);
});

test('checking without selecting any option shows prompt and does not record checked state', () => {
  const dom = createDomEnvironment({ pathname: '/lessons/0001-unselected.html', html: SAMPLE_QUIZ_HTML });
  loadWidget(dom);

  const q1 = dom.document.querySelector('[data-quiz-question="q1"]');
  const checkBtn = q1.querySelector('[data-quiz-check]');
  const feedback = q1.querySelector('[data-quiz-feedback]');

  dom.document.dispatchEvent({ type: 'click', target: checkBtn });
  assert.equal(feedback.textContent, 'Pick an answer first.');
  assert.equal(dom.localStorage.getItem('teach.quiz:/lessons/0001-unselected.html'), null);
});

test('supports custom feedback attributes on options and questions', () => {
  const customHtml = `
    <div data-quiz-question="custom1" data-feedback-correct="Custom correct!" data-feedback-incorrect="Custom wrong!">
      <input type="radio" name="c1" value="right" data-correct>
      <input type="radio" name="c1" value="wrong" data-feedback="Specific option feedback.">
      <button type="button" data-quiz-check>Check</button>
      <div data-quiz-feedback></div>
    </div>
  `;
  const dom = createDomEnvironment({ pathname: '/lessons/0001-custom.html', html: customHtml });
  loadWidget(dom);

  const q = dom.document.querySelector('[data-quiz-question="custom1"]');
  const fb = q.querySelector('[data-quiz-feedback]');
  const btn = q.querySelector('[data-quiz-check]');

  // Test custom incorrect message from option attribute
  const wrongInput = q.querySelector('input[value="wrong"]');
  wrongInput.checked = true;
  dom.document.dispatchEvent({ type: 'change', target: wrongInput });
  dom.document.dispatchEvent({ type: 'click', target: btn });
  assert.equal(fb.textContent, 'Specific option feedback.');

  // Test custom correct message from question attribute
  const rightInput = q.querySelector('input[value="right"]');
  rightInput.checked = true;
  dom.document.dispatchEvent({ type: 'change', target: rightInput });
  dom.document.dispatchEvent({ type: 'click', target: btn });
  assert.equal(fb.textContent, 'Custom correct!');
});

test('gracefully degrades when localStorage throws errors (e.g. security block or quota exceeded)', () => {
  const dom = createDomEnvironment({ pathname: '/lessons/0001-throws.html', html: SAMPLE_QUIZ_HTML });
  dom.localStorage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  dom.localStorage.getItem = () => {
    throw new Error('SecurityError');
  };

  assert.doesNotThrow(() => loadWidget(dom));

  const q1 = dom.document.querySelector('[data-quiz-question="q1"]');
  const optionB = q1.querySelector('input[value="b"]');
  const checkBtn = q1.querySelector('[data-quiz-check]');

  optionB.checked = true;
  assert.doesNotThrow(() => dom.document.dispatchEvent({ type: 'change', target: optionB }));
  assert.doesNotThrow(() => dom.document.dispatchEvent({ type: 'click', target: checkBtn }));
  assert.equal(q1.querySelector('[data-quiz-feedback]').textContent, 'Correct.');
});


// ---- Free-text questions ---------------------------------------------------------------------
// A free-text question is a quiz question like the others (see QUIZ-FORMAT.md): a .quiz-q inside
// section.quiz with the lesson's own button, the feedback line, and a hidden model answer. With chat
// live the button sends the learner's words to the teacher; without it, it reveals the model answer.

const FREETEXT_HTML = `
<main>
  <section class="quiz">
    <h2>Check your understanding</h2>
    <div class="quiz-q" data-quiz-question="f1" data-quiz-type="freetext">
      <p>In your own words, what does a loop do?</p>
      <textarea name="f1"></textarea>
      <button type="button" data-quiz-check>Show model answer</button>
      <p class="fb" data-quiz-feedback></p>
      <div data-quiz-answer hidden>A loop repeats work until a condition stops it.</div>
    </div>
  </section>
</main>
`;
const STORE_KEY = 'teach.quiz:/lessons/0001-loops.html';

// A page as the learner meets it. `answerWith` stands in for the chat panel's reply to an answer being
// sent; null means no chat panel is listening at all.
function freetextPage(answerWith, html = FREETEXT_HTML) {
  const dom = createDomEnvironment({ pathname: '/lessons/0001-loops.html', html });
  loadWidget(dom);
  const sent = [];
  dom.document.addEventListener('teach:send-answer', (event) => {
    sent.push({ id: event.detail.id, text: event.detail.text });
    if (answerWith) event.detail.respond(answerWith);
  });
  const box = dom.document.querySelector('[data-quiz-question="f1"]');
  const field = box.querySelector('textarea');
  const answer = box.querySelector('[data-quiz-answer]');
  const type = (text) => {
    field.value = text;
    dom.document.dispatchEvent({ type: 'input', target: field });
  };
  const stored = () => JSON.parse(dom.localStorage.getItem(STORE_KEY) || '{}').f1;
  const statusText = () => box.querySelector('[data-quiz-feedback]').textContent;
  const press = () => dom.document.dispatchEvent({ type: 'click', target: box.querySelector('[data-quiz-check]') });
  const revealed = () => !answer.hasAttribute('hidden');
  return { dom, box, field, answer, type, stored, statusText, press, revealed, sent };
}

test('the lesson supplies the button and the model answer; the widget adds neither', () => {
  const { box } = freetextPage();
  assert.equal(box.querySelectorAll('button').length, 1, 'only the lesson button');
  assert.equal(box.querySelectorAll('[data-quiz-send]').length, 0);
});

test('with chat live, the button sends the words to the teacher and the model answer stays hidden', () => {
  const page = freetextPage('sent');
  page.type('A loop repeats work.');
  page.press();
  assert.deepEqual(page.sent, [{ id: 'f1', text: 'A loop repeats work.' }]);
  assert.equal(page.revealed(), false, 'not revealed');
  assert.match(page.statusText(), /Sent to your teacher.*chat panel/);
  assert.deepEqual(page.stored(), { text: 'A loop repeats work.', sent: true, revealed: false });
});

test('with no chat, the button reveals the model answer and says how to get feedback', () => {
  const page = freetextPage(null);
  page.type('A loop repeats work.');
  page.press();
  assert.equal(page.revealed(), true);
  assert.match(page.statusText(), /not connected/i);
  assert.match(page.statusText(), /conversation with the teacher/i);
  assert.deepEqual(page.stored(), { text: 'A loop repeats work.', sent: false, revealed: true });
});

test('chat that is switched off (the panel answers "unavailable") reveals the model answer too', () => {
  const page = freetextPage('unavailable');
  page.type('An answer.');
  page.press();
  assert.equal(page.revealed(), true);
});

test('the chat panel can refuse an answer: the reason is shown, nothing is sent and nothing is revealed', () => {
  const reasons = {
    notice: /notice/i,
    busy: /still answering/i,
    'not-interactive': /another page/i,
    'too-long': /too long/i,
  };
  for (const [reason, pattern] of Object.entries(reasons)) {
    const page = freetextPage(reason);
    page.type('An answer.');
    page.press();
    assert.match(page.statusText(), pattern, reason);
    assert.equal(page.revealed(), false, `${reason} does not reveal`);
    assert.equal(page.stored().sent, false, `${reason} is not sent`);
  }
});

test('an empty answer is neither sent nor lets the model answer be revealed', () => {
  for (const answerWith of ['sent', null]) {
    const page = freetextPage(answerWith);
    page.type('   ');
    page.press();
    assert.equal(page.sent.length, 0);
    assert.equal(page.revealed(), false);
    assert.match(page.statusText(), /Write your answer first/);
  }
});

test('typing saves the words for this lesson under the question id', () => {
  const { type, stored } = freetextPage();
  type('A loop repeats work.');
  assert.deepEqual(stored(), { text: 'A loop repeats work.', sent: false, revealed: false });
});

test('changing a sent answer makes it unsent again and clears the line', () => {
  const page = freetextPage('sent');
  page.type('First try.');
  page.press();
  page.type('Second try.');
  assert.deepEqual(page.stored(), { text: 'Second try.', sent: false, revealed: false });
  assert.equal(page.statusText(), '');
});

test('reloading restores the words, whether they were sent, and a revealed model answer', () => {
  const reload = (from) => {
    const fresh = createDomEnvironment({ pathname: '/lessons/0001-loops.html', html: FREETEXT_HTML });
    for (const [k, v] of from.dom.localStorage._raw.entries()) fresh.localStorage.setItem(k, v);
    loadWidget(fresh);
    const box = fresh.document.querySelector('[data-quiz-question="f1"]');
    return {
      words: box.querySelector('textarea').value,
      status: box.querySelector('[data-quiz-feedback]').textContent,
      revealed: !box.querySelector('[data-quiz-answer]').hasAttribute('hidden'),
    };
  };

  const sentPage = freetextPage('sent');
  sentPage.type('A loop repeats work.');
  sentPage.press();
  const afterSent = reload(sentPage);
  assert.equal(afterSent.words, 'A loop repeats work.');
  assert.match(afterSent.status, /Sent to your teacher/);
  assert.equal(afterSent.revealed, false);

  const revealedPage = freetextPage(null);
  revealedPage.type('My answer');
  revealedPage.press();
  assert.equal(reload(revealedPage).revealed, true);
});

test('a free-text question and a radio question live together, each behaving as itself', () => {
  const page = freetextPage('sent', FREETEXT_HTML + SAMPLE_QUIZ_HTML);
  const q1 = page.dom.document.querySelector('[data-quiz-question="q1"]');
  page.dom.document.dispatchEvent({ type: 'click', target: q1.querySelector('[data-quiz-check]') });
  assert.equal(q1.querySelector('[data-quiz-feedback]').textContent, 'Pick an answer first.');
  assert.equal(page.sent.length, 0, 'the radio Check did not send anything');

  page.type('An answer.');
  page.press();
  assert.equal(page.sent.length, 1);
  assert.match(page.statusText(), /Sent to your teacher/, 'the radio quiz did not touch the free-text line');
});

test('a reload signal keeps a typed free-text answer', () => {
  const page = freetextPage('sent');
  page.type('Half written');
  page.dom.document.dispatchEvent({ type: 'teach:lesson-updated' });
  assert.equal(page.field.value, 'Half written');
});
