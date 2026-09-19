(function () {
  'use strict';

  var TOKEN_KEY = 'teach.token';

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

  function start() {
    takeTokenFromUrl();
    var root = document.createElement('div');
    root.id = 'teach-widget';
    document.body.appendChild(root);
    var token = storedToken();
    if (token) connect(token, 1000);
    else setStream('no-token');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
