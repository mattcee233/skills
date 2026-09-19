'use strict';
// The teacher's replies are Markdown. The widget shows them by building DOM nodes (never innerHTML),
// so nothing a reply contains, including text the agent read from a web page, can become markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../bridge/widget/markdown');

// A tiny document: enough for the renderer, and easy to read back as HTML-like text.
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.className = '';
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  set textContent(value) {
    this.children = [makeText(value)];
  }
}
const makeText = (value) => ({ tagName: '#text', text: String(value) });
const doc = { createElement: (tag) => new FakeNode(tag), createTextNode: makeText };

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function html(node) {
  if (node.tagName === '#text') return escape(node.text);
  const tag = node.tagName.toLowerCase();
  const attrs = Object.entries(node.attributes).map(([k, v]) => ` ${k}="${v}"`).join('');
  const cls = node.className ? ` class="${node.className}"` : '';
  return `<${tag}${cls}${attrs}>${node.children.map(html).join('')}</${tag}>`;
}
// The rendered body without the wrapper, so tests read the part they care about.
const body = (text) => render(text, doc).children.map(html).join('');
const elements = (node, tag, found = []) => {
  if (node.tagName === tag.toUpperCase()) found.push(node);
  for (const child of node.children || []) elements(child, tag, found);
  return found;
};

test('headings of every level become headings of different sizes, and never the page-sized h1', () => {
  assert.equal(body('# One'), '<h3 class="teach-md-h1">One</h3>');
  assert.equal(body('## Two'), '<h4 class="teach-md-h2">Two</h4>');
  assert.equal(body('### Three'), '<h5 class="teach-md-h3">Three</h5>');
  assert.equal(body('#### Four'), '<h6 class="teach-md-h4">Four</h6>');
  assert.equal(body('###### Six'), '<h6 class="teach-md-h6">Six</h6>');
  assert.equal(body('## Trailing hashes ##'), '<h4 class="teach-md-h2">Trailing hashes</h4>');
});

test('a hash without a space, or seven hashes, is not a heading', () => {
  assert.equal(body('#nospace'), '<p>#nospace</p>');
  assert.equal(body('####### seven'), '<p>####### seven</p>');
});

test('bold, italic, bold italic and underline', () => {
  assert.equal(body('a **bold** and __also bold__'), '<p>a <strong>bold</strong> and <strong>also bold</strong></p>');
  assert.equal(body('an *italic* and _also italic_ word'), '<p>an <em>italic</em> and <em>also italic</em> word</p>');
  assert.equal(body('***both***'), '<p><strong><em>both</em></strong></p>');
  assert.equal(body('some <u>underlined</u> text'), '<p>some <u>underlined</u> text</p>');
  assert.equal(body('**bold with <u>underline</u> and *italic* inside**'), '<p><strong>bold with <u>underline</u> and <em>italic</em> inside</strong></p>');
});

test('markers that do not mean emphasis stay as written', () => {
  assert.equal(body('use my_variable_name and snake_case_here'), '<p>use my_variable_name and snake_case_here</p>');
  assert.equal(body('2 * 3 * 4 = 24'), '<p>2 * 3 * 4 = 24</p>');
  assert.equal(body('an **unclosed bold and a lone * star'), '<p>an **unclosed bold and a lone * star</p>');
  assert.equal(body('\\*not italic\\* and \\# not a heading'), '<p>*not italic* and # not a heading</p>');
});

test('inline code is literal', () => {
  assert.equal(body('call `a*b*c` now'), '<p>call <code>a*b*c</code> now</p>');
  assert.equal(body('`<b>x</b>`'), '<p><code>&lt;b&gt;x&lt;/b&gt;</code></p>');
});

test('a code block keeps its lines and is not read as Markdown', () => {
  const out = body('before\n\n```python\nfor i in range(3):\n    print("**hi**")\n```\n\nafter');
  assert.equal(out, '<p>before</p><pre><code>for i in range(3):\n    print("**hi**")</code></pre><p>after</p>');
});

test('an unclosed code block runs to the end rather than swallowing nothing', () => {
  assert.equal(body('```\nline one\nline two'), '<pre><code>line one\nline two</code></pre>');
});

test('bullet and numbered lists, with emphasis inside items', () => {
  assert.equal(body('- **Intro:** it now says\n- second'), '<ul><li><strong>Intro:</strong> it now says</li><li>second</li></ul>');
  assert.equal(body('* one\n+ two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(body('1. first\n2. second\n10) tenth'), '<ol><li>first</li><li>second</li><li>tenth</li></ol>');
});

test('a numbered list after a bullet list is a separate list', () => {
  assert.equal(body('- a\n- b\n\n1. one\n2. two'), '<ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol>');
  assert.equal(body('- a\n  1. inner\n- b'), '<ul><li>a<ol><li>inner</li></ol></li><li>b</li></ul>');
});

test('nested lists follow the indent', () => {
  assert.equal(
    body('- a\n  - a1\n  - a2\n- b'),
    '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>',
  );
});

test('paragraphs split on a blank line, and a single newline is a line break', () => {
  assert.equal(body('one\ntwo\n\nthree'), '<p>one<br></br>two</p><p>three</p>');
});

test('a quote and a rule', () => {
  assert.equal(body('> a **quoted** line\n> more'), '<blockquote><p>a <strong>quoted</strong> line<br></br>more</p></blockquote>');
  assert.equal(body('above\n\n---\n\nbelow'), '<p>above</p><hr></hr><p>below</p>');
});

test('a list, a heading and a paragraph in one reply', () => {
  const out = body('## Grade\n\nMostly there.\n\n- right: the core idea\n- missing: the stop rule');
  assert.equal(out, '<h4 class="teach-md-h2">Grade</h4><p>Mostly there.</p><ul><li>right: the core idea</li><li>missing: the stop rule</li></ul>');
});

test('links open safely, and only web links are links', () => {
  const link = render('see [the docs](https://example.com/a?b=1)', doc);
  const [a] = elements(link, 'a');
  assert.equal(a.attributes.href, 'https://example.com/a?b=1');
  assert.equal(a.attributes.rel, 'noopener noreferrer');
  assert.equal(a.attributes.target, '_blank');

  for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,<script>1</script>)', '[x](vbscript:1)', '[x](//evil.example)', '[x](file:///etc/passwd)']) {
    assert.equal(elements(render(bad, doc), 'a').length, 0, `${bad} is not a link`);
  }
});

test('raw HTML from a reply is text, never an element', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<b onclick="x()">bold</b>',
    '<u onclick="x()">not underline</u>',
    '<style>body{display:none}</style>',
  ];
  for (const text of hostile) {
    const tree = render(text, doc);
    for (const tag of ['script', 'img', 'iframe', 'a', 'b', 'style']) {
      assert.equal(elements(tree, tag).length, 0, `${text} makes no <${tag}>`);
    }
    for (const u of elements(tree, 'u')) assert.deepEqual(u.attributes, {}, 'an underline carries no attributes');
  }
  assert.equal(body('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('nothing the renderer makes can carry an event handler or a style', () => {
  const text = '# h\n**b** *i* <u>u</u> `c`\n\n- l\n\n> q\n\n[a](https://e.example)\n\n```\ncode\n```';
  const walk = (node) => {
    for (const name of Object.keys(node.attributes || {})) {
      assert.ok(['href', 'rel', 'target'].includes(name), `unexpected attribute ${name}`);
    }
    (node.children || []).forEach(walk);
  };
  walk(render(text, doc));
});

test('a huge or pathological reply is shown as plain text and does not hang the page', () => {
  const started = Date.now();
  const nasty = ['**a ', '_b ', '*c ', '`d ', '[e ', '<u>'].map((s) => s.repeat(20000)).join('');
  const tree = render(nasty, doc);
  assert.ok(Date.now() - started < 2000, 'rendered quickly');
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].tagName, '#text');
  assert.equal(tree.children[0].text, nasty, 'the words are all there');
});

test('deep nesting is cut off rather than recursing without limit', () => {
  const deep = '> '.repeat(200) + 'x';
  assert.doesNotThrow(() => render(deep, doc));
  const nested = '**'.repeat(300) + 'x' + '**'.repeat(300);
  assert.doesNotThrow(() => render(nested, doc));
});

test('the text of a reply survives: every word is still in the output', () => {
  const text = '## Grade: mostly there\n\n**What is right:** a loop repeats.\n\n- _missing:_ the stop rule';
  const tree = render(text, doc);
  const read = (node) => (node.tagName === '#text' ? node.text : (node.children || []).map(read).join(' '));
  const words = read(tree).replace(/\s+/g, ' ');
  for (const word of ['Grade:', 'mostly', 'there', 'What', 'right:', 'loop', 'repeats.', 'missing:', 'stop', 'rule']) {
    assert.ok(words.includes(word), `"${word}" is present`);
  }
  assert.doesNotMatch(words, /\*\*|##|_missing/);
});

test('an empty reply renders nothing to show, and a non-string is handled', () => {
  assert.equal(body(''), '');
  assert.equal(body(undefined), '');
  assert.equal(body(null), '');
});

test('plain() gives the reply as spoken words, with no Markdown marks, for a screen reader', () => {
  const { plain } = require('../bridge/widget/markdown');
  const text = '## Grade: mostly there\n\n**What is right:** a `loop` repeats.\n\n- _missing:_ the stop rule\n- [docs](https://example.com)';
  assert.equal(plain(text, doc), 'Grade: mostly there What is right: a loop repeats. missing: the stop rule docs');
  assert.equal(plain('', doc), '');
  assert.equal(plain('plain words', doc), 'plain words');
});
