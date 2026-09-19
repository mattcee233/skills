(function () {
  'use strict';

  var TOKEN_KEY = 'teach.token';
  var THREAD_KEY = 'teach.thread';
  var TAB_KEY = 'teach.tab';
  var DUPLICATE_CHECK_MS = 250;
  var POLL_MS = 1500;
  var POLL_FAILURES_BEFORE_GIVING_UP = 5;
  var HINT_AFTER_SECONDS = [
    [25, 'Deeper questions take a little longer.'],
    [60, 'Still working: long answers can take several minutes. You can keep reading; the reply will appear here even if this page reloads.'],
  ];

  // What to say for each error code when the adapter gave no guidance of its own.
  var FALLBACK_HINTS = {
    missing: "The teacher's engine is not installed. Install it, then run /teach again.",
    'not-logged-in': "The teacher's engine is not logged in. Log in to it, then try again.",
    unreachable: 'The teacher could not be reached. Check that it is running, then try again.',
    unauthorised: "The teacher's engine refused its credentials. Check its connection settings.",
    timeout: 'The teacher took too long to reply. Try again, or ask something smaller.',
    'in-use': 'AI interaction is only available on one page at a time and you already have another page open.',
    failed: 'Something went wrong. Try again.',
    lost: 'The teaching server restarted, so the reply was lost. Try again.',
  };
  // What to say in the "Chat not connected" state when the adapter gave no guidance of its own,
  // by the handshake's reason.
  var CONNECT_FALLBACKS = {
    missing: "The teacher's engine is not installed. Install it, then press Retry.",
    'not-logged-in': "The teacher's engine is not logged in. Log in to it, then press Retry.",
    unreachable: 'The teacher could not be reached. Check that it is running, then press Retry.',
    unauthorised: "The teacher's engine refused its credentials. Check its connection settings, then press Retry.",
    conformance: 'The connector did not pass its safety check, so chat is switched off. Press Retry, or run /teach interactive.',
    'no-adapter': 'Chat is not set up for this workspace. Run /teach interactive to set it up.',
    error: 'The connection test could not finish. Press Retry.',
    timeout: 'The connection test took too long. Press Retry.',
    other: 'The connection test did not finish. Press Retry.',
  };
  var RETRYABLE = { timeout: true, failed: true, unreachable: true, lost: true };

  // The server puts the session token in the URL fragment, which the browser never sends
  // anywhere. Keep it in localStorage and take it out of the address bar.
  function takeTokenFromUrl() {
    var fromUrl = new URLSearchParams(location.hash.slice(1)).get('t');
    if (!fromUrl) return;
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch (err) {
      // Storage is blocked: the page stays a plain lesson.
    }
    history.replaceState(null, '', location.pathname + location.search);
  }

  function storedToken() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch (err) {
      return null;
    }
  }

  // ---- Which tab this is ----------------------------------------------------------------------
  // Each tab has an id in sessionStorage, which survives moving from lesson to lesson in the same
  // tab. A duplicated tab copies sessionStorage, so it would share the original's id. On load a tab
  // asks the others on a BroadcastChannel whether anyone already has its id, and takes a fresh one
  // if so. A page that is being left does not answer, or the next page of the same tab would think
  // it was a copy.
  function readTabId() {
    try {
      return sessionStorage.getItem(TAB_KEY);
    } catch (err) {
      return null;
    }
  }

  function saveTabId(id) {
    try {
      sessionStorage.setItem(TAB_KEY, id);
    } catch (err) {
      // No session storage: the id lasts for this page only.
    }
  }

  function resolveTabId(done) {
    var id = readTabId() || newId();
    saveTabId(id);
    if (typeof BroadcastChannel === 'undefined') return done(id);
    var channel = new BroadcastChannel('teach-tabs');
    var nonce = newId();
    var leaving = false;
    var settled = false;
    channel.onmessage = function (event) {
      var message = event.data || {};
      if (message.type === 'hello' && message.id === id && message.nonce !== nonce && !leaving) {
        channel.postMessage({ type: 'have', id: id, to: message.nonce });
      } else if (message.type === 'have' && message.to === nonce && !settled) {
        id = newId();
        saveTabId(id);
        finish();
      }
    };
    window.addEventListener('pagehide', function () {
      leaving = true;
    });
    window.addEventListener('pageshow', function () {
      leaving = false;
    });
    function finish() {
      if (settled) return;
      settled = true;
      done(id);
    }
    channel.postMessage({ type: 'hello', id: id, nonce: nonce });
    return setTimeout(finish, DUPLICATE_CHECK_MS);
  }

  function setStream(state) {
    document.documentElement.setAttribute('data-teach-stream', state);
  }

  // One SSE frame ("event: x" and "data: {...}" lines) becomes an event on the document,
  // for the parts of the widget that later tickets add. Comment lines are ignored.
  function dispatchFrame(frame) {
    var type = 'message';
    var data = [];
    frame.split('\n').forEach(function (line) {
      if (line.indexOf('event:') === 0) type = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) data.push(line.slice(5).trim());
    });
    if (!data.length) return;
    var payload;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch (err) {
      return;
    }
    document.dispatchEvent(new CustomEvent('teach:event', { detail: { type: type, data: payload } }));
  }

  // EventSource cannot send a header, so read the stream with fetch to keep the token
  // out of the URL.
  // The page from an earlier session finds nothing at its address, or a different server that does not
  // know its token. Two failures in a row (or a refused token) say the teaching server is gone.
  var FAILURES_BEFORE_DEAD = 2;

  function tellStream(state) {
    document.dispatchEvent(new CustomEvent('teach:stream', { detail: { state: state } }));
  }

  function connect(token, tab, delay, failures) {
    setStream('connecting');
    fetch('/events', { headers: { 'X-Teach-Token': token, 'X-Teach-Tab': tab } })
      .then(function (response) {
        if (response.status === 401) {
          setStream('unauthorised');
          tellStream('lost');
          return null;
        }
        if (!response.ok) throw new Error('stream refused');
        setStream('open');
        tellStream('open');
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        function pump() {
          return reader.read().then(function (result) {
            if (result.done) return;
            buffer += decoder.decode(result.value, { stream: true });
            var frames = buffer.split('\n\n');
            buffer = frames.pop();
            frames.forEach(dispatchFrame);
            return pump();
          });
        }
        return pump().then(function () {
          failures = -1;
          throw new Error('stream ended');
        });
      })
      .catch(function () {
        setStream('closed');
        var failed = (failures || 0) + 1;
        if (failed >= FAILURES_BEFORE_DEAD) tellStream('lost');
        setTimeout(function () {
          connect(token, tab, Math.min(delay * 2, 10000), failed);
        }, delay);
      });
  }

  // ---- The chat thread ------------------------------------------------------------------
  // The thread lives in localStorage only: it survives reloads and moving between lessons,
  // and is never written to the workspace. Entries are
  //   { kind: 'you', id, text, lesson, title, sentAt, status: 'pending' | 'done' | 'failed' }
  //   { kind: 'teacher', text }
  //   { kind: 'error', forId, code, message, hint }
  //   { kind: 'fresh', generation }   (the agent conversation was started again)

  function loadThread() {
    try {
      var saved = JSON.parse(localStorage.getItem(THREAD_KEY));
      return Array.isArray(saved) ? saved : [];
    } catch (err) {
      return [];
    }
  }

  function saveThread(thread) {
    try {
      localStorage.setItem(THREAD_KEY, JSON.stringify(thread));
    } catch (err) {
      // Storage is full or blocked: the chat still works for this page.
    }
  }

  function newId() {
    var bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.prototype.map
      .call(bytes, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      })
      .join('');
  }

  function lessonLabel(path, title) {
    var name = path.split('/').pop().replace(/\.html?$/i, '');
    var match = /^0*(\d+)/.exec(name);
    var where = match ? 'lesson ' + match[1] : name;
    return title ? where + ': ' + title : where;
  }

  function currentLesson() {
    var heading = document.querySelector('h1');
    return { path: location.pathname, title: (heading ? heading.textContent : document.title).trim() };
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clock(seconds) {
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  // What the page says about the lease when it does not hold it.
  var LEASE_NOTICES = {
    'not-interactive': 'AI interaction is only available on one page at a time and you already have another page open.',
    displaced: 'Another page took over AI interaction.',
    free: 'The other page has closed, so AI interaction is free.',
  };
  // The same states as a short line for the status pill on a narrow screen.
  var LEASE_PILLS = {
    'not-interactive': 'Another page has AI interaction',
    displaced: 'Another page took over AI interaction',
    free: 'The other page has closed',
  };
  // Said before the permissions when the connector was written by the AI for this workspace.
  var UNREVIEWED_LINE = 'This connector was written by an AI for this workspace and has not been reviewed. Check what it does before you rely on it.';
  var WIDE_QUERY = '(min-width: 1000px)';
  var ACK_KEY_PREFIX = 'teach.ack.';

  // One widget, two layouts. Wide (1000px and up): a docked panel on the right that the lesson makes
  // room for, open by default and collapsible to an edge tab. Narrow: a slim bar along the bottom
  // (thread toggle, message box, send) with the thread in a sheet that slides up, closed by default.
  // It is one set of elements: only the styles change with the screen, so resizing across the
  // breakpoint keeps the thread, what was typed and any pending reply.
  function startChat(token, tab, hooks) {
    var thread = loadThread();
    var root = document.getElementById('teach-widget');
    var panel = element('section', 'teach-panel');
    panel.setAttribute('aria-label', 'Ask the teacher');

    var head = element('div', 'teach-head');
    head.appendChild(element('h2', 'teach-heading', 'Ask the teacher'));
    var collapse = element('button', 'teach-collapse', 'Hide');
    collapse.type = 'button';
    collapse.setAttribute('aria-controls', 'teach-sheet');
    head.appendChild(collapse);

    var sheet = element('div', 'teach-sheet');
    sheet.id = 'teach-sheet';
    var permission = element('div', 'teach-permission');
    permission.hidden = true;
    var notice = element('div', 'teach-lease');
    notice.hidden = true;
    var list = element('div', 'teach-thread');
    list.setAttribute('role', 'log');
    list.setAttribute('aria-live', 'off');
    list.setAttribute('aria-label', 'Conversation with your teacher');
    list.tabIndex = 0;
    sheet.appendChild(permission);
    sheet.appendChild(notice);
    sheet.appendChild(list);

    var bar = element('div', 'teach-bar');
    var status = element('div', 'teach-status');
    status.hidden = true;
    status.tabIndex = -1;
    var form = element('form', 'teach-composer');
    var toggle = element('button', 'teach-toggle', 'Thread');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', 'teach-sheet');
    var input = element('textarea', 'teach-input');
    input.rows = 2;
    input.setAttribute('aria-label', 'Message for your teacher');
    input.placeholder = 'Ask a question, or ask for a change...';
    var send = element('button', 'teach-send', 'Send');
    send.type = 'submit';
    form.appendChild(toggle);
    form.appendChild(input);
    form.appendChild(send);
    bar.appendChild(status);
    bar.appendChild(form);

    panel.appendChild(head);
    panel.appendChild(sheet);
    panel.appendChild(bar);

    // The tab a collapsed wide panel leaves at the edge of the screen.
    var edge = element('button', 'teach-edge', 'Ask the teacher');
    edge.type = 'button';
    edge.setAttribute('aria-controls', 'teach-sheet');
    edge.setAttribute('aria-expanded', 'false');

    // Two regions for a screen reader: replies are announced politely, errors at once. The thread
    // itself is redrawn whole, so it is not a live region.
    var polite = element('div', 'teach-sr');
    polite.setAttribute('role', 'status');
    polite.setAttribute('aria-live', 'polite');
    var assertive = element('div', 'teach-sr');
    assertive.setAttribute('role', 'alert');

    root.appendChild(panel);
    root.appendChild(edge);
    root.appendChild(polite);
    root.appendChild(assertive);

    var pollTimer = null;
    var pollFailures = 0;
    // Whether this page holds the lease: 'unknown' until the server says, then 'interactive',
    // 'not-interactive', 'displaced' (another page took it) or 'free' (the holder went away).
    // Only the holder sends, waits for replies or writes the thread.
    var lease = 'unknown';
    var leaseProblem = '';
    // What the adapter said the agent is allowed to do, and whether the learner has confirmed it.
    var permissionInfo = { text: '', improvised: false };
    var confirmedHere = false;
    var chatShown = false;
    panel.hidden = true;
    edge.hidden = true;
    // Layout: open or closed for each of the two layouts, and whether there is something new to
    // read while the sheet is closed.
    var isOpenIn = { wide: true, narrow: false };
    var unread = false;
    var query = window.matchMedia ? window.matchMedia(WIDE_QUERY) : null;

    function announce(region, text) {
      region.textContent = '';
      setTimeout(function () {
        region.textContent = text;
      }, 50);
    }

    // ---- layout

    function isWide() {
      return query ? query.matches : true;
    }

    function isOpen() {
      return isOpenIn[isWide() ? 'wide' : 'narrow'];
    }

    function applyLayout() {
      var wide = isWide();
      var open = isOpen();
      root.setAttribute('data-layout', wide ? 'wide' : 'narrow');
      root.setAttribute('data-open', open ? 'true' : 'false');
      document.documentElement.setAttribute('data-teach-dock', chatShown && wide && open ? 'open' : 'closed');
      document.documentElement.setAttribute('data-teach-bar', chatShown && !wide ? 'on' : 'off');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      collapse.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('data-unread', unread && !open ? 'true' : 'false');
    }

    function setOpen(value) {
      isOpenIn[isWide() ? 'wide' : 'narrow'] = value;
      if (value) unread = false;
      applyLayout();
      renderStatus();
    }

    toggle.addEventListener('click', function () {
      setOpen(!isOpen());
    });
    collapse.addEventListener('click', function () {
      setOpen(false);
      edge.focus();
    });
    edge.addEventListener('click', function () {
      setOpen(true);
      collapse.focus();
    });
    // Escape closes the sheet on a narrow screen and puts focus back on its toggle.
    sheet.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !isWide() && isOpen()) {
        setOpen(false);
        toggle.focus();
      }
    });
    if (query) {
      if (query.addEventListener) query.addEventListener('change', applyLayout);
      else query.addListener(applyLayout);
    }

    // ---- the permission notice

    function ackKey() {
      return ACK_KEY_PREFIX + token.slice(0, 16);
    }

    // Confirmed for this session: the flag is keyed by the session's token, and it holds the text that
    // was confirmed, so different words are asked about again. It blocks the message box here only.
    function confirmed() {
      if (confirmedHere) return true;
      try {
        return localStorage.getItem(ackKey()) === permissionInfo.text;
      } catch (err) {
        return false;
      }
    }

    function needsConfirming() {
      return !!permissionInfo.text && !confirmed();
    }

    function confirm() {
      confirmedHere = true;
      try {
        localStorage.setItem(ackKey(), permissionInfo.text);
      } catch (err) {
        // Storage is blocked: the confirmation lasts for this page only.
      }
      render();
      input.focus();
    }

    function renderPermission() {
      permission.textContent = '';
      var show = lease === 'interactive' && needsConfirming();
      permission.hidden = !show;
      if (!show) return;
      if (permissionInfo.improvised) permission.appendChild(element('p', 'teach-unreviewed', UNREVIEWED_LINE));
      var line = element('p');
      line.appendChild(element('strong', null, 'Before you start: '));
      line.appendChild(document.createTextNode('The agent session will have the following permissions: ' + permissionInfo.text));
      permission.appendChild(line);
      var ok = element('button', 'teach-send', 'I understand');
      ok.type = 'button';
      ok.addEventListener('click', confirm);
      permission.appendChild(ok);
    }

    // ---- the thread

    function findMessage(matches) {
      for (var i = 0; i < thread.length; i += 1) {
        if (thread[i].kind === 'you' && matches(thread[i])) return thread[i];
      }
      return null;
    }

    function pendingMessage() {
      return findMessage(function (message) {
        return message.status === 'pending';
      });
    }

    function messageById(id) {
      return findMessage(function (message) {
        return message.id === id;
      });
    }

    function latestErrorIndex() {
      for (var i = thread.length - 1; i >= 0; i -= 1) {
        if (thread[i].kind === 'error') return i;
      }
      return -1;
    }

    function render() {
      list.textContent = '';
      var lastLesson = null;
      var errorIndex = latestErrorIndex();
      thread.forEach(function (entry, index) {
        if (entry.kind === 'you') {
          if (entry.lesson !== lastLesson) {
            list.appendChild(element('div', 'teach-divider', 'Sent from ' + lessonLabel(entry.lesson, entry.title)));
            lastLesson = entry.lesson;
          }
          list.appendChild(element('div', 'teach-message teach-you', entry.text));
        } else if (entry.kind === 'fresh') {
          list.appendChild(element('div', 'teach-divider', 'Fresh start'));
        } else if (entry.kind === 'teacher') {
          list.appendChild(element('div', 'teach-message teach-teacher', entry.text));
        } else if (entry.kind === 'error') {
          var block = element('div', 'teach-error');
          block.appendChild(element('strong', null, "Couldn't send (" + entry.code + ')'));
          block.appendChild(element('p', null, entry.message));
          block.appendChild(element('p', null, entry.hint || FALLBACK_HINTS[entry.code] || FALLBACK_HINTS.failed));
          if (index === errorIndex && entry.code === 'in-use' && lease !== 'interactive') {
            var takeover = element('button', 'teach-retry', 'Use this page instead');
            takeover.type = 'button';
            takeover.addEventListener('click', takeLeaseNow);
            block.appendChild(takeover);
          } else if (index === errorIndex && (RETRYABLE[entry.code] || (entry.code === 'in-use' && lease === 'interactive'))) {
            var retry = element('button', 'teach-retry', 'Try again');
            retry.type = 'button';
            retry.addEventListener('click', function () {
              tryAgain(entry.forId);
            });
            block.appendChild(retry);
          }
          list.appendChild(block);
        }
      });
      var waiting = pendingMessage();
      var holds = lease === 'interactive';
      var usable = holds && !needsConfirming();
      input.disabled = !!waiting || !usable;
      send.disabled = !!waiting || !usable;
      input.placeholder = !holds
        ? 'Disabled on this page'
        : !usable
          ? 'Read the notice first'
          : waiting
            ? 'Waiting for your teacher...'
            : 'Ask a question, or ask for a change...';
      renderPermission();
      renderNotice();
      renderStatus();
      applyLayout();
      list.scrollTop = list.scrollHeight;
    }

    // The fixed message for a page that does not hold the lease, with the button that takes it.
    function renderNotice() {
      notice.textContent = '';
      var text = LEASE_NOTICES[lease];
      notice.hidden = !text;
      if (!text) return;
      notice.setAttribute('data-lease', lease);
      notice.appendChild(element('p', null, text));
      if (leaseProblem) notice.appendChild(element('p', 'teach-lease-problem', leaseProblem));
      var take = element('button', lease === 'free' ? 'teach-send' : 'teach-retry', 'Use this page instead');
      take.type = 'button';
      take.addEventListener('click', takeLeaseNow);
      notice.appendChild(take);
    }

    function takeLeaseNow() {
      leaseProblem = '';
      hooks.takeLease().then(function (problem) {
        if (problem) {
          leaseProblem = problem;
          renderNotice();
        }
      });
    }

    // The status pill, on its own line above the message box. "Thinking" shows on every screen. The
    // lines that send the learner to the sheet (read the notice, another page, a new reply) matter
    // where the sheet can be closed, so they show on a narrow screen only, as a button that opens it.
    function attention(text) {
      status.hidden = false;
      status.setAttribute('data-kind', 'attention');
      var button = element('button', 'teach-status-button', text);
      button.type = 'button';
      button.addEventListener('click', function () {
        if (!isOpen()) setOpen(true);
      });
      status.appendChild(button);
    }

    function renderStatus() {
      status.textContent = '';
      var waiting = pendingMessage();
      if (lease === 'interactive' && needsConfirming()) return attention('Read the notice first');
      if (lease !== 'interactive' && lease !== 'unknown') return attention(LEASE_PILLS[lease]);
      if (waiting) {
        var seconds = Math.max(0, Math.floor((Date.now() - waiting.sentAt) / 1000));
        status.hidden = false;
        status.setAttribute('data-kind', 'thinking');
        var line = element('div', 'teach-thinking');
        line.appendChild(element('span', 'teach-spinner'));
        line.appendChild(document.createTextNode('I am thinking... ' + clock(seconds)));
        status.appendChild(line);
        var hints = HINT_AFTER_SECONDS.filter(function (pair) {
          return seconds >= pair[0];
        });
        if (hints.length) status.appendChild(element('div', 'teach-hint', hints[hints.length - 1][1]));
        return undefined;
      }
      if (unread && !isOpen()) return attention('New reply');
      status.hidden = true;
      return undefined;
    }

    // A page that has lost the lease may still be handed an answer it was already waiting for. The
    // answer is written into the thread as the holder left it, not this page's older copy.
    function current(message) {
      if (lease === 'interactive') return message;
      thread = loadThread();
      return messageById(message.id) || message;
    }

    // Focus stays where the learner put it: only a learner who is still in the widget is moved back to
    // the message box when the reply arrives.
    function returnFocus() {
      if (panel.contains(document.activeElement)) input.focus();
    }

    function fail(message, code, text, hint) {
      message = current(message);
      message.status = 'failed';
      thread.push({ kind: 'error', forId: message.id, code: code, message: text, hint: hint || '' });
      saveThread(thread);
      if (!isOpen()) unread = true;
      render();
      announce(assertive, "Couldn't send: " + text + ' ' + (hint || FALLBACK_HINTS[code] || FALLBACK_HINTS.failed));
      returnFocus();
    }

    function settle(message, result) {
      message = current(message);
      if (result && result.ok) {
        message.status = 'done';
        thread.push({ kind: 'teacher', text: result.text });
        saveThread(thread);
        if (!isOpen()) unread = true;
        render();
        announce(polite, 'Your teacher replied: ' + result.text);
        returnFocus();
      } else {
        var error = (result && result.error) || {};
        fail(message, error.code || 'failed', error.message || 'The teacher could not reply.', error.hint);
      }
    }

    // A reply is handed over once. If the server no longer knows a message, the page that held the lease
    // a moment ago may have collected the reply and written it into the thread, so look there (for a
    // moment, since that page may still be writing) before calling the message lost.
    function settledElsewhere(message, tries) {
      if (lease !== 'interactive') return;
      thread = loadThread();
      var saved = messageById(message.id);
      if (saved && saved.status !== 'pending') {
        render();
        return;
      }
      if (tries < 3) {
        pollTimer = setTimeout(function () {
          settledElsewhere(message, tries + 1);
        }, 400);
        return;
      }
      fail(saved || message, 'lost', 'That message was lost.');
    }

    // Ask the server for a message's outcome. A reloaded page does exactly this for a message
    // that was still pending when it went away.
    function poll() {
      clearTimeout(pollTimer);
      var message = pendingMessage();
      if (!message || lease !== 'interactive') return;
      fetch('/reply/' + encodeURIComponent(message.id), { headers: { 'X-Teach-Token': token } })
        .then(function (response) {
          if (response.status === 401) {
            fail(message, 'unauthorised', 'This page is no longer connected to its teaching server.', 'Run /teach for a fresh link.');
            return null;
          }
          if (!response.ok) throw new Error('reply refused');
          return response.json().then(function (body) {
            pollFailures = 0;
            if (body.status === 'done') settle(message, body.result);
            else if (body.status === 'unknown') settledElsewhere(message, 0);
            else pollTimer = setTimeout(poll, POLL_MS);
          });
        })
        .catch(function () {
          // The server may be busy or briefly unreachable: keep asking for a while.
          pollFailures += 1;
          if (pollFailures >= POLL_FAILURES_BEFORE_GIVING_UP) {
            pollFailures = 0;
            fail(message, 'unreachable', 'Could not reach the teaching server.');
          } else {
            pollTimer = setTimeout(poll, POLL_MS);
          }
        });
    }

    // Hand a message to the server, then wait for its outcome. If the answer to the POST is
    // lost, the message may still have arrived, so ask for its outcome instead of assuming it
    // failed: the server says "unknown" if it never saw it.
    function deliver(message) {
      fetch('/send', {
        method: 'POST',
        headers: { 'X-Teach-Token': token, 'X-Teach-Tab': tab, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: message.id, lesson: message.lesson, text: message.text }),
      })
        .then(function (response) {
          if (response.status === 202) return poll();
          if (response.status === 401) {
            return fail(message, 'unauthorised', 'This page is no longer connected to its teaching server.', 'Run /teach for a fresh link.');
          }
          return response
            .json()
            .catch(function () {
              return null;
            })
            .then(function (body) {
              var error = (body && body.error) || {};
              // The server says another page holds the lease: believe it over what this page thought.
              if (error.code === 'in-use') hooks.setLease('not-interactive');
              fail(message, error.code || 'failed', error.message || 'That message could not be sent.', error.hint);
            });
        })
        .catch(poll);
    }

    function submit(text) {
      var lesson = currentLesson();
      var message = { kind: 'you', id: newId(), text: text, lesson: lesson.path, title: lesson.title, sentAt: Date.now(), status: 'pending' };
      thread.push(message);
      saveThread(thread);
      render();
      // The message box is disabled while the reply is pending, which would drop keyboard focus out of
      // the widget: the status line takes it, and reads out that the teacher is working.
      status.focus();
      deliver(message);
    }

    // "Try again" sends the same words as a new message. Nothing is ever resent on its own.
    function tryAgain(forId) {
      var message = messageById(forId);
      if (!message || pendingMessage()) return;
      thread = thread.filter(function (entry) {
        return !(entry.kind === 'error' && entry.forId === forId);
      });
      var lesson = currentLesson();
      message.id = newId();
      message.status = 'pending';
      message.sentAt = Date.now();
      message.lesson = lesson.path;
      message.title = lesson.title;
      saveThread(thread);
      render();
      status.focus();
      deliver(message);
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = input.value;
      if (!text.trim() || pendingMessage() || input.disabled) return;
      input.value = '';
      submit(text);
    });

    // Enter sends; Shift+Enter adds a line.
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    // A page that does not hold the lease shows the holder's conversation as it changes.
    window.addEventListener('storage', function (event) {
      if (event.key !== THREAD_KEY || lease === 'interactive') return;
      thread = loadThread();
      render();
    });

    setInterval(renderStatus, 1000);
    render();

    // What the connection state does with the chat: show it, hide it (the thread is kept, in
    // memory and in localStorage), and mark a new agent conversation.
    return {
      // The server's word on the lease. Becoming the holder reads the thread again, since another
      // page has been writing it, and collects any reply that was still pending.
      setLease: function (next) {
        var before = lease;
        lease = next;
        if (next === 'interactive' && before !== 'interactive') {
          thread = loadThread();
          leaseProblem = '';
          render();
          if (pendingMessage()) poll();
        } else {
          if (next !== 'interactive') clearTimeout(pollTimer);
          render();
        }
      },
      // What the adapter said the agent may do (its own words) and whether it was improvised.
      setPermissions: function (text, improvised) {
        permissionInfo = { text: typeof text === 'string' ? text : '', improvised: !!improvised };
        render();
      },
      show: function () {
        chatShown = true;
        panel.hidden = false;
        edge.hidden = false;
        document.documentElement.setAttribute('data-teach-chat', 'on');
        applyLayout();
      },
      hide: function () {
        chatShown = false;
        panel.hidden = true;
        edge.hidden = true;
        document.documentElement.setAttribute('data-teach-chat', 'off');
        applyLayout();
      },
      freshStart: function (generation) {
        var seen = thread.some(function (entry) {
          return entry.kind === 'fresh' && entry.generation === generation;
        });
        if (seen || !thread.length) return;
        thread.push({ kind: 'fresh', generation: generation });
        saveThread(thread);
        render();
      },
    };
  }

  // ---- The connection state ---------------------------------------------------------------
  // The server tests its connection to the agent after the page is served. Until it says how it
  // went the widget shows "Connecting...". Then either live chat, or a collapsed "Chat not
  // connected" pill: opened, it shows the adapter's hint and a Retry button, with no message box
  // and no permission notice. Retry runs the test again on the server, and success switches this
  // same widget to live chat with no reload. The thread is kept whichever way it goes.

  // The lesson and its quiz are the lesson's own and keep working; only the chat is gone.
  var DEAD_SERVER_MESSAGE = "The teaching server isn't running. This page is from an earlier session: run /teach for a fresh link. The lesson and quiz still work here.";

  function startConnection(token, tab, root) {
    var chat = null;
    var lease = 'unknown';
    var verdict = { state: 'pending' };
    var expanded = false;
    var retryProblem = '';
    var dead = false;

    var gate = element('div', 'teach-pill');
    var toggle = element('button', 'teach-pill-toggle');
    toggle.type = 'button';
    var detail = element('div', 'teach-pill-detail');
    gate.appendChild(toggle);
    gate.appendChild(detail);
    root.appendChild(gate);
    toggle.addEventListener('click', function () {
      expanded = !expanded;
      renderGate();
    });

    function hintFor(state) {
      if (state.hint) return state.hint;
      var reason = state.state === 'error' ? 'error' : state.reason;
      return CONNECT_FALLBACKS[reason] || CONNECT_FALLBACKS.other;
    }

    function renderGate() {
      if (dead) {
        gate.hidden = false;
        gate.setAttribute('data-state', 'dead');
        detail.textContent = '';
        toggle.textContent = 'Teaching server not running';
        toggle.disabled = false;
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        detail.hidden = !expanded;
        detail.appendChild(element('p', null, DEAD_SERVER_MESSAGE));
        return;
      }
      if (verdict.state === 'interactive') {
        gate.hidden = true;
        return;
      }
      gate.hidden = false;
      gate.setAttribute('data-state', verdict.state);
      detail.textContent = '';
      if (verdict.state === 'pending') {
        toggle.textContent = 'Connecting...';
        toggle.disabled = true;
        toggle.setAttribute('aria-expanded', 'false');
        detail.hidden = true;
        return;
      }
      toggle.textContent = 'Chat not connected';
      toggle.disabled = false;
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      detail.hidden = !expanded;
      detail.appendChild(element('p', null, hintFor(verdict)));
      if (retryProblem) detail.appendChild(element('p', 'teach-pill-problem', retryProblem));
      var retry = element('button', 'teach-retry', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', function () {
        retry.disabled = true;
        retryConnection();
      });
      detail.appendChild(retry);
    }

    function apply(next) {
      if (!next || typeof next.state !== 'string') return;
      verdict = next;
      retryProblem = '';
      if (next.state === 'interactive') {
        if (!chat) chat = startChat(token, tab, { takeLease: takeLease, setLease: setLease });
        chat.setPermissions(next.permissions, next.improvised);
        chat.setLease(lease);
        if (dead) chat.hide();
        else chat.show();
        if (typeof next.generation === 'number' && next.generation > 1) chat.freshStart(next.generation);
      } else if (chat) {
        chat.hide();
      }
      renderGate();
    }

    function retryConnection() {
      var before = verdict;
      fetch('/retry', { method: 'POST', headers: { 'X-Teach-Token': token, 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (response) {
          if (response.status === 401) throw new Error('unauthorised');
          return response.json();
        })
        .then(function (next) {
          // The stream usually gets there first; a slower answer must not overwrite a newer state.
          if (verdict === before) apply(next);
        })
        .catch(function () {
          retryProblem = 'Could not reach the teaching server. Run /teach for a fresh link.';
          renderGate();
        });
    }

    function setLease(next) {
      lease = next;
      if (chat) chat.setLease(next);
    }

    // Ask for the lease. Resolves to null when the server gave it, otherwise to what to tell the learner.
    function takeLease() {
      return fetch('/lease/take', { method: 'POST', headers: { 'X-Teach-Token': token, 'X-Teach-Tab': tab, 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (response) {
          if (response.ok) {
            setLease('interactive');
            return null;
          }
          if (response.status === 409) return 'This page is not connected to the teaching server yet. Try again in a moment.';
          return 'Could not take over. Run /teach for a fresh link.';
        })
        .catch(function () {
          return 'Could not reach the teaching server. Run /teach for a fresh link.';
        });
    }

    // The stream says when the server has gone (the message opens by itself: it is all there is to
    // read) and when it is back, which the state the server then sends puts right.
    document.addEventListener('teach:stream', function (event) {
      var gone = event.detail.state === 'lost';
      if (gone === dead) return;
      dead = gone;
      if (gone) {
        expanded = true;
        if (chat) chat.hide();
      } else if (chat && verdict.state === 'interactive') {
        chat.show();
      }
      renderGate();
    });

    // The server sends the current state when the stream opens, and again on every change.
    document.addEventListener('teach:event', function (event) {
      var type = event.detail.type;
      var data = event.detail.data || {};
      if (type === 'handshake') apply(data);
      else if (type === 'lease' && (data.state === 'interactive' || data.state === 'not-interactive')) setLease(data.state);
      else if (type === 'displaced') setLease('displaced');
      else if (type === 'lease-free' && lease !== 'interactive') setLease('free');
    });
    renderGate();
  }

  // ---- Signals from the teacher ---------------------------------------------------------------
  // The agent tells an open page that a lesson changed, through the server. The events carry no
  // history: the lesson on disk is the truth, and a page that opens later is served fresh. So a
  // signal is only a nudge, and it never moves the learner or discards anything they have done.
  //   next-lesson {lesson, title}   the "next lesson" button now points here
  //   reload {lesson}               this lesson changed on disk

  var TOAST_KEY = 'teach.toast';
  var TOAST_SECONDS = 7;
  var UPDATED_TOAST = 'Your teacher updated this lesson. Your answers and chat were kept.';

  function startToasts(root) {
    var host = element('div', 'teach-toasts');
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    root.appendChild(host);
    return function toast(text) {
      var note = element('div', 'teach-toast', text);
      host.appendChild(note);
      setTimeout(function () {
        if (note.parentNode) note.parentNode.removeChild(note);
      }, TOAST_SECONDS * 1000);
    };
  }

  // The button is found by its hook, so the agent and the page both rewrite the same element. The
  // latest event always wins: a learner's question can spawn a lesson and change where "next" goes.
  // The same target twice changes nothing. Nothing here scrolls or navigates.
  function upsertNextButton(root, lesson, title) {
    var label = 'Next lesson: ' + title;
    var button = document.querySelector('[data-teach-next]');
    if (button && button.getAttribute('href') === lesson && button.textContent === label) return null;
    if (!button) {
      button = element('a', 'teach-next');
      button.setAttribute('data-teach-next', '');
      document.body.insertBefore(button, root);
    }
    button.setAttribute('href', lesson);
    button.textContent = label;
    return button;
  }

  function pulse(button) {
    button.classList.remove('teach-pulse');
    // Reading a layout property makes the browser restart the animation if it is added again.
    void button.offsetWidth;
    button.classList.add('teach-pulse');
    setTimeout(function () {
      button.classList.remove('teach-pulse');
    }, 2500);
  }

  // Bring the lesson on screen up to date without losing the learner's place. The lesson is
  // replaced in place (chat, pending reply and anything typed live in the widget, outside it). A
  // lesson with scripts of its own could not be swapped safely, so that one is loaded afresh: the
  // chat, the pending reply and stored answers all live in localStorage and come back with it.
  function isWidgetNode(node) {
    var src = (node.getAttribute && (node.getAttribute('src') || node.getAttribute('href'))) || '';
    return src.indexOf('/_teach/') === 0;
  }

  function swapLesson(html, root) {
    var next = new DOMParser().parseFromString(html, 'text/html');
    var scripts = Array.prototype.filter.call(next.querySelectorAll('script'), function (node) {
      return !isWidgetNode(node);
    });
    Array.prototype.forEach.call(next.querySelectorAll('script, link'), function (node) {
      if (isWidgetNode(node)) node.parentNode.removeChild(node);
    });
    var hasOwnScripts = scripts.length > 0 || !!document.querySelector('body script:not([src^="/_teach/"])');
    if (hasOwnScripts) return false;

    var scrollX = window.scrollX;
    var scrollY = window.scrollY;
    Array.prototype.slice.call(document.body.childNodes).forEach(function (node) {
      if (node !== root && !isWidgetNode(node)) document.body.removeChild(node);
    });
    Array.prototype.slice.call(next.body.childNodes).forEach(function (node) {
      document.body.insertBefore(document.importNode(node, true), root);
    });
    if (next.title) document.title = next.title;
    Array.prototype.slice.call(document.head.querySelectorAll('style')).forEach(function (node) {
      document.head.removeChild(node);
    });
    Array.prototype.forEach.call(next.head.querySelectorAll('style'), function (node) {
      document.head.appendChild(document.importNode(node, true));
    });
    window.scrollTo(scrollX, scrollY);
    document.dispatchEvent(new CustomEvent('teach:lesson-updated'));
    return true;
  }

  function reloadLesson(root, toast) {
    fetch(location.pathname, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('lesson not served');
        return response.text();
      })
      .then(function (html) {
        if (swapLesson(html, root)) return toast(UPDATED_TOAST);
        try {
          sessionStorage.setItem(TOAST_KEY, UPDATED_TOAST);
        } catch (err) {
          // Without session storage the page still reloads, just without the note.
        }
        return location.reload();
      })
      .catch(function () {
        toast('Your teacher updated this lesson. Refresh the page to see it.');
      });
  }

  function startSignals(root) {
    var toast = startToasts(root);
    try {
      var waiting = sessionStorage.getItem(TOAST_KEY);
      if (waiting) {
        sessionStorage.removeItem(TOAST_KEY);
        toast(waiting);
      }
    } catch (err) {
      // No session storage: nothing was left waiting.
    }
    document.addEventListener('teach:event', function (event) {
      var type = event.detail.type;
      var data = event.detail.data || {};
      if (type === 'next-lesson' && typeof data.lesson === 'string' && typeof data.title === 'string') {
        var button = upsertNextButton(root, data.lesson, data.title);
        if (!button) return;
        pulse(button);
        toast('Your teacher added a next lesson: ' + data.title + '.');
      } else if (type === 'reload' && data.lesson === location.pathname) {
        reloadLesson(root, toast);
      }
    });
  }

  function start() {
    takeTokenFromUrl();
    var root = document.createElement('div');
    root.id = 'teach-widget';
    document.body.appendChild(root);
    var token = storedToken();
    if (!token) {
      setStream('no-token');
      return;
    }
    startSignals(root);
    // The stream announces the tab, so it waits until the tab knows its id (a copy takes a new one).
    resolveTabId(function (tab) {
      startConnection(token, tab, root);
      connect(token, tab, 1000, 0);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
