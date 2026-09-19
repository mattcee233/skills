(function () {
  'use strict';

  // Shows the teacher's Markdown reply in the chat panel. A reply may contain text the agent read from
  // a web page, so nothing here goes through innerHTML: every element is made with createElement and
  // every string with createTextNode. The only attributes ever set are the href, rel and target of a
  // web link. Raw HTML in a reply is shown as the text it is; the one exception is <u>...</u>, which the
  // teacher uses for underline (Markdown has none), and which is read as an underline and nothing else.
  //
  // Read: headings (# to ######), **bold**, *italic*, ***both***, <u>underline</u>, `code`, code blocks,
  // bullet and numbered lists (nested by indent), > quotes, rules, and [text](https://link).

  // Past this size the reply is shown as plain text, so a huge or hostile reply cannot make the page work
  // for long. Nesting of quotes, lists and emphasis stops at MAX_DEPTH for the same reason.
  var MAX_LENGTH = 50000;
  var MAX_DEPTH = 6;

  function makeText(doc, value) {
    return doc.createTextNode(value);
  }

  function make(doc, tag, className) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  // ---- Inline: what happens inside a line -----------------------------------------------------
  // Each pattern finds the next piece of markup. The earliest wins, and where two start together the
  // one listed first wins (so ***x*** is read before **x**).
  var INLINE = [
    { name: 'escape', re: /\\([\\`*_{}\[\]()#+\-.!<>|~])/g },
    { name: 'code', re: /`([^`\n]+)`/g },
    { name: 'link', re: /\[([^\]\n]+)\]\(([^\s)]+)\)/g },
    { name: 'underline', re: /<u>([\s\S]*?)<\/u>/gi },
    { name: 'bolditalic', re: /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g },
    { name: 'bold', re: /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/g },
    { name: 'italic', re: /\*(?=[^\s*])([\s\S]*?[^\s*])\*|_(?=[^\s_])([\s\S]*?[^\s_])_/g },
  ];
  var WORD = /[A-Za-z0-9_]/;
  var WEB_LINK = /^https?:\/\/\S+$/i;

  // An underscore only means emphasis at the edge of a word, so snake_case_names stay as written.
  function underscoreOk(str, start, end, usedUnderscore) {
    if (!usedUnderscore) return true;
    var before = start > 0 ? str.charAt(start - 1) : '';
    var after = end < str.length ? str.charAt(end) : '';
    return !(before && WORD.test(before)) && !(after && WORD.test(after));
  }

  function parseInline(str, doc, depth, out) {
    if (depth > MAX_DEPTH) {
      out.appendChild(makeText(doc, str));
      return;
    }
    var pos = 0;
    var cache = INLINE.map(function () {
      return undefined;
    });
    while (pos < str.length) {
      var best = null;
      var bestAt = -1;
      for (var i = 0; i < INLINE.length; i += 1) {
        var found = cache[i];
        if (found === undefined || (found && found.index < pos)) {
          INLINE[i].re.lastIndex = pos;
          found = INLINE[i].re.exec(str);
          cache[i] = found;
        }
        if (found && (best === null || found.index < best.index)) {
          best = found;
          bestAt = i;
        }
      }
      if (!best) break;

      var name = INLINE[bestAt].name;
      var end = best.index + best[0].length;
      var valid = true;
      if (name === 'bold' || name === 'italic') valid = underscoreOk(str, best.index, end, best[2] !== undefined);
      if (name === 'link') valid = WEB_LINK.test(best[2]);
      if (!valid) {
        // Not markup after all: keep its first character as text and look again from the next.
        out.appendChild(makeText(doc, str.slice(pos, best.index + 1)));
        pos = best.index + 1;
        continue;
      }

      if (best.index > pos) out.appendChild(makeText(doc, str.slice(pos, best.index)));
      if (name === 'escape') {
        out.appendChild(makeText(doc, best[1]));
      } else if (name === 'code') {
        var code = make(doc, 'code');
        code.appendChild(makeText(doc, best[1]));
        out.appendChild(code);
      } else if (name === 'link') {
        var link = make(doc, 'a');
        link.setAttribute('href', best[2]);
        link.setAttribute('rel', 'noopener noreferrer');
        link.setAttribute('target', '_blank');
        parseInline(best[1], doc, depth + 1, link);
        out.appendChild(link);
      } else if (name === 'underline') {
        var underline = make(doc, 'u');
        parseInline(best[1], doc, depth + 1, underline);
        out.appendChild(underline);
      } else if (name === 'bolditalic') {
        var strong = make(doc, 'strong');
        var em = make(doc, 'em');
        parseInline(best[1], doc, depth + 1, em);
        strong.appendChild(em);
        out.appendChild(strong);
      } else if (name === 'bold') {
        var bold = make(doc, 'strong');
        parseInline(best[1] !== undefined ? best[1] : best[2], doc, depth + 1, bold);
        out.appendChild(bold);
      } else {
        var italic = make(doc, 'em');
        parseInline(best[1] !== undefined ? best[1] : best[2], doc, depth + 1, italic);
        out.appendChild(italic);
      }
      pos = end;
    }
    if (pos < str.length) out.appendChild(makeText(doc, str.slice(pos)));
  }

  // Lines inside one paragraph or item: a single newline is a line break, as in a chat.
  function inlineLines(str, doc, depth, out) {
    str.split('\n').forEach(function (line, index) {
      if (index) out.appendChild(make(doc, 'br'));
      parseInline(line, doc, depth, out);
    });
  }

  // ---- Blocks: headings, lists, quotes, code, paragraphs ---------------------------------------
  var FENCE = /^\s{0,3}```/;
  var FENCE_END = /^\s{0,3}```\s*$/;
  var HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  var RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var QUOTE = /^\s{0,3}>\s?(.*)$/;
  var ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

  function startsBlock(line) {
    return FENCE.test(line) || (HEADING.test(line) && HEADING.exec(line)[2] !== '') || RULE.test(line) || QUOTE.test(line) || ITEM.test(line);
  }

  // A heading is shown one size down from its level, because the panel already has its own title, and
  // no smaller than h6. The class keeps the levels apart visually.
  function headingTag(level) {
    return 'h' + Math.min(level + 2, 6);
  }

  function indentOf(spaces) {
    return spaces.replace(/\t/g, '  ').length;
  }

  // Consecutive list lines, and the lines indented under an item, become items with their indent.
  function collectItems(lines, from) {
    var items = [];
    var i = from;
    while (i < lines.length) {
      var line = lines[i];
      var match = ITEM.exec(line);
      if (match) {
        items.push({ indent: indentOf(match[1]), ordered: /\d/.test(match[2]), text: match[3] });
        i += 1;
      } else if (!line.trim()) {
        // A blank line inside a list only continues it when the next thing is another item.
        var next = i + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        if (next < lines.length && ITEM.test(lines[next])) i = next;
        else break;
      } else if (items.length && /^\s{2,}\S/.test(line) && !FENCE.test(line)) {
        items[items.length - 1].text += '\n' + line.trim();
        i += 1;
      } else {
        break;
      }
    }
    return { items: items, next: i };
  }

  function buildList(items, doc, depth, out) {
    var stack = [];
    items.forEach(function (item) {
      while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) stack.pop();
      var top = stack[stack.length - 1];
      // Changing from bullets to numbers (or back) at the same indent starts a new list.
      if (top && item.indent === top.indent && item.ordered !== top.ordered) {
        stack.pop();
        top = stack[stack.length - 1];
        var sibling = make(doc, item.ordered ? 'ol' : 'ul');
        if (top) top.lastItem.appendChild(sibling);
        else out.appendChild(sibling);
        stack.push({ indent: item.indent, ordered: item.ordered, list: sibling, lastItem: null });
        top = stack[stack.length - 1];
      } else if (!top || (item.indent > top.indent && depth + stack.length < MAX_DEPTH)) {
        var list = make(doc, item.ordered ? 'ol' : 'ul');
        if (top) top.lastItem.appendChild(list);
        else out.appendChild(list);
        top = { indent: item.indent, ordered: item.ordered, list: list, lastItem: null };
        stack.push(top);
      }
      var li = make(doc, 'li');
      inlineLines(item.text, doc, depth + stack.length, li);
      top.list.appendChild(li);
      top.lastItem = li;
    });
  }

  function parseBlocks(lines, doc, depth, out) {
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }

      if (FENCE.test(line)) {
        var code = [];
        i += 1;
        while (i < lines.length && !FENCE_END.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1;
        var pre = make(doc, 'pre');
        var inner = make(doc, 'code');
        inner.appendChild(makeText(doc, code.join('\n')));
        pre.appendChild(inner);
        out.appendChild(pre);
        continue;
      }

      var heading = HEADING.exec(line);
      if (heading && heading[2] !== '') {
        var h = make(doc, headingTag(heading[1].length), 'teach-md-h' + heading[1].length);
        parseInline(heading[2], doc, depth, h);
        out.appendChild(h);
        i += 1;
        continue;
      }

      if (RULE.test(line)) {
        out.appendChild(make(doc, 'hr'));
        i += 1;
        continue;
      }

      if (QUOTE.test(line)) {
        var quoted = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          quoted.push(QUOTE.exec(lines[i])[1]);
          i += 1;
        }
        var quote = make(doc, 'blockquote');
        if (depth + 1 >= MAX_DEPTH) {
          var flat = make(doc, 'p');
          flat.appendChild(makeText(doc, quoted.join('\n')));
          quote.appendChild(flat);
        } else {
          parseBlocks(quoted, doc, depth + 1, quote);
        }
        out.appendChild(quote);
        continue;
      }

      if (ITEM.test(line)) {
        var collected = collectItems(lines, i);
        buildList(collected.items, doc, depth, out);
        i = collected.next;
        continue;
      }

      var paragraph = [];
      while (i < lines.length && lines[i].trim() && (paragraph.length === 0 || !startsBlock(lines[i]))) {
        paragraph.push(lines[i]);
        i += 1;
      }
      var p = make(doc, 'p');
      inlineLines(paragraph.join('\n'), doc, depth, p);
      out.appendChild(p);
    }
  }

  // The reply as a <div class="teach-md">. A reply that is too long comes back as its words alone.
  function render(value, doc) {
    doc = doc || document;
    var root = make(doc, 'div', 'teach-md');
    var str = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
    if (!str.trim()) return root;
    if (str.length > MAX_LENGTH) {
      root.className = 'teach-md teach-md-plain';
      root.appendChild(makeText(doc, str));
      return root;
    }
    parseBlocks(str.split('\n'), doc, 0, root);
    return root;
  }

  // The reply as the words a person would say, for the screen reader's announcement: the same reading as
  // render, with the marks gone and a space between blocks.
  function plain(value, doc) {
    var words = [];
    (function walk(node) {
      if (node.nodeType === 3 || node.tagName === '#text') {
        words.push(node.text !== undefined ? node.text : node.nodeValue);
        return;
      }
      var kids = node.childNodes || node.children || [];
      for (var i = 0; i < kids.length; i += 1) walk(kids[i]);
      // Spaces between blocks keep the last word of one from running into the first of the next.
      if (/^(P|H[1-6]|LI|BLOCKQUOTE|PRE|HR|BR)$/.test(node.tagName || '')) words.push(' ');
    })(render(value, doc));
    return words.join('').replace(/\s+/g, ' ').trim();
  }

  var api = { render: render, plain: plain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.teachMarkdown = api;
})();
