'use strict';
// Test helpers: a temporary teaching workspace and an HTTP client for the bridge server.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-ws-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function url(server, pathname, host = '127.0.0.1') {
  return `http://${host}:${server.port}${pathname}`;
}

// Open the SSE stream with fetch (EventSource cannot send the token header).
// Returns { response, waitFor(regex), close() }.
async function openEvents(server, token, host = '127.0.0.1') {
  const controller = new AbortController();
  const headers = token ? { 'X-Teach-Token': token } : {};
  const response = await fetch(url(server, '/events', host), { headers, signal: controller.signal });
  let received = '';
  const waiting = [];
  if (response.ok) {
    (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of response.body) {
          received += decoder.decode(chunk, { stream: true });
          for (const w of [...waiting]) {
            if (w.pattern.test(received)) {
              waiting.splice(waiting.indexOf(w), 1);
              w.resolve(received);
            }
          }
        }
      } catch {
        // aborted by close()
      }
    })();
  }
  return {
    response,
    get received() {
      return received;
    },
    waitFor(pattern, ms = 2000) {
      if (pattern.test(received)) return Promise.resolve(received);
      return new Promise((resolve, reject) => {
        const entry = { pattern, resolve };
        waiting.push(entry);
        setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; got: ${received}`)), ms).unref();
      });
    },
    close() {
      controller.abort();
    },
  };
}

module.exports = { makeWorkspace, openEvents, url };
