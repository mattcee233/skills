(function () {
  'use strict';

  var TOKEN_KEY = 'teach.token';
  var THREAD_KEY = 'teach.thread';
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
  function connect(token, delay) {
    setStream('connecting');
    fetch('/events', { headers: { 'X-Teach-Token': token } })
      .then(function (response) {
        if (response.status === 401) {
          setStream('unauthorised');
          return null;
        }
        if (!response.ok) throw new Error('stream refused');
        setStream('open');
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
          throw new Error('stream ended');
        });
      })
      .catch(function () {
        setStream('closed');
        setTimeout(function () {
          connect(token, Math.min(delay * 2, 10000));
        }, delay);
      });
  }

  // ---- The chat thread ------------------------------------------------------------------
  // The thread lives in localStorage only: it survives reloads and moving between lessons,
  // and is never written to the workspace. Entries are
  //   { kind: 'you', id, text, lesson, title, sentAt, status: 'pending' | 'done' | 'failed' }
  //   { kind: 'teacher', text }
  //   { kind: 'error', forId, code, message, hint }

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

  function startChat(token) {
    var thread = loadThread();
    var panel = element('section', 'teach-panel');
    panel.setAttribute('aria-label', 'Ask the teacher');
    var heading = element('h2', 'teach-heading', 'Ask the teacher');
    var list = element('div', 'teach-thread');
    list.setAttribute('role', 'log');
    list.setAttribute('aria-live', 'polite');
    var status = element('div', 'teach-status');
    status.hidden = true;
    var form = element('form', 'teach-composer');
    var input = element('textarea', 'teach-input');
    input.rows = 2;
    input.setAttribute('aria-label', 'Message for your teacher');
    input.placeholder = 'Ask a question, or ask for a change...';
    var send = element('button', 'teach-send', 'Send');
    send.type = 'submit';
    form.appendChild(input);
    form.appendChild(send);
    panel.appendChild(heading);
    panel.appendChild(list);
    panel.appendChild(status);
    panel.appendChild(form);
    var root = document.getElementById('teach-widget');
    root.appendChild(panel);
    document.documentElement.setAttribute('data-teach-chat', 'on');

    var pollTimer = null;
    var pollFailures = 0;

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
        } else if (entry.kind === 'teacher') {
          list.appendChild(element('div', 'teach-message teach-teacher', entry.text));
        } else if (entry.kind === 'error') {
          var block = element('div', 'teach-error');
          block.setAttribute('role', 'alert');
          block.appendChild(element('strong', null, "Couldn't send (" + entry.code + ')'));
          block.appendChild(element('p', null, entry.message));
          block.appendChild(element('p', null, entry.hint || FALLBACK_HINTS[entry.code] || FALLBACK_HINTS.failed));
          if (index === errorIndex && RETRYABLE[entry.code]) {
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
      input.disabled = !!waiting;
      send.disabled = !!waiting;
      input.placeholder = waiting ? 'Waiting for your teacher...' : 'Ask a question, or ask for a change...';
      renderStatus();
      list.scrollTop = list.scrollHeight;
    }

    function renderStatus() {
      var waiting = pendingMessage();
      if (!waiting) {
        status.hidden = true;
        status.textContent = '';
        return;
      }
      var seconds = Math.max(0, Math.floor((Date.now() - waiting.sentAt) / 1000));
      status.hidden = false;
      status.textContent = '';
      var line = element('div', 'teach-thinking');
      line.appendChild(element('span', 'teach-spinner'));
      line.appendChild(document.createTextNode('I am thinking... ' + clock(seconds)));
      status.appendChild(line);
      var hints = HINT_AFTER_SECONDS.filter(function (pair) {
        return seconds >= pair[0];
      });
      if (hints.length) status.appendChild(element('div', 'teach-hint', hints[hints.length - 1][1]));
    }

    function fail(message, code, text, hint) {
      message.status = 'failed';
      thread.push({ kind: 'error', forId: message.id, code: code, message: text, hint: hint || '' });
      saveThread(thread);
      render();
    }

    function settle(message, result) {
      if (result && result.ok) {
        message.status = 'done';
        thread.push({ kind: 'teacher', text: result.text });
        saveThread(thread);
        render();
        input.focus();
      } else {
        var error = (result && result.error) || {};
        fail(message, error.code || 'failed', error.message || 'The teacher could not reply.', error.hint);
      }
    }

    // Ask the server for a message's outcome. A reloaded page does exactly this for a message
    // that was still pending when it went away.
    function poll() {
      clearTimeout(pollTimer);
      var message = pendingMessage();
      if (!message) return;
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
            else if (body.status === 'unknown') fail(message, 'lost', 'That message was lost.');
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
        headers: { 'X-Teach-Token': token, 'Content-Type': 'application/json' },
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
      deliver(message);
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = input.value;
      if (!text.trim() || pendingMessage()) return;
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

    setInterval(renderStatus, 1000);
    render();
    if (pendingMessage()) poll();
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
    connect(token, 1000);
    startChat(token);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
