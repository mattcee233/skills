'use strict';
// Test helper: creates and runs a stub Pithagoras webhook server for testing the adapter.
const http = require('node:http');

function makeStubPithagoras(t, initialOptions = {}) {
  let options = { ...initialOptions };
  const calls = [];

  const server = http.createServer((req, res) => {
    let bodyRaw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      bodyRaw += chunk;
    });

    req.on('end', async () => {
      let parsedBody = null;
      try {
        if (bodyRaw.trim()) parsedBody = JSON.parse(bodyRaw);
      } catch {}

      const callRecord = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody,
        rawBody: bodyRaw,
        receivedAt: Date.now(),
      };
      calls.push(callRecord);

      // Check for connection drop option
      if (options.dropConnection) {
        req.socket.destroy();
        return;
      }

      // Check for delay option
      if (options.delayMs > 0) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }

      // If a custom handler is defined
      if (typeof options.onCall === 'function') {
        options.onCall(req, parsedBody, res);
        return;
      }

      // Verify X-Portal-Secret
      const expectedSecret = options.secret !== undefined ? options.secret : 'test-portal-secret';
      const givenSecret = req.headers['x-portal-secret'];
      if (expectedSecret && givenSecret !== expectedSecret) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad or missing X-Portal-Secret' }));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'POST only' }));
        return;
      }

      if (options.status) {
        res.writeHead(options.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(options.body || {}));
        return;
      }

      if (options.refusal) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          reply: 'I only talk to people I have been introduced to. If you are the owner, configure access in the portal.',
        }));
        return;
      }

      if (options.stopped) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply: 'Stopped.' }));
        return;
      }

      // Default successful response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        reply: options.reply !== undefined ? options.reply : 'Default response from Pithagoras stub.',
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/`;

      const stub = {
        port,
        url,
        secret: options.secret !== undefined ? options.secret : 'test-portal-secret',
        calls() {
          return [...calls];
        },
        clearCalls() {
          calls.length = 0;
        },
        setConfig(nextOptions) {
          options = { ...options, ...nextOptions };
        },
        close() {
          return new Promise((res) => server.close(res));
        },
      };

      if (t && typeof t.after === 'function') {
        t.after(() => stub.close());
      }

      resolve(stub);
    });
  });
}

module.exports = { makeStubPithagoras };
