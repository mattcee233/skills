#!/usr/bin/env node
'use strict';
// The Pithagoras bridge adapter: talks to the learner's Pithagoras instance through its webhook.
// Implements check, prime and send according to the adapter contract:
// reads one JSON request on stdin, writes one JSON line on stdout.
//   node pithagoras.js [--url <url>] [--secret <secret>] [--timeout <ms>] [--ceiling <ms>]
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const PITHAGORAS_PERMISSIONS =
  "The agent runs with its process's full permissions and has no approval prompts. Web research is not guaranteed and depends on your Pithagoras configuration.";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 900 seconds
const DEFAULT_CEILING_MS = 15 * 60 * 1000;

const DEFAULT_MESSAGES = {
  missing: 'Pithagoras webhook is not configured.',
  'not-logged-in': 'Pithagoras credentials were not accepted.',
  unreachable: 'Pithagoras could not be reached.',
  unauthorised: 'Pithagoras credentials were not accepted.',
  timeout: 'Pithagoras took too long to reply.',
  failed: 'Pithagoras could not complete the request.',
};

const DEFAULT_HINTS = {
  missing: 'Configure the Pithagoras webhook URL and secret, then press Retry.',
  'not-logged-in': 'Check your Pithagoras webhook secret, then press Retry.',
  unreachable: 'Make sure Pithagoras is running and the webhook URL is reachable, then press Retry.',
  unauthorised: 'Check your Pithagoras webhook secret, then press Retry.',
  timeout: 'The agent may still be working in the background. Press Try again to retry.',
  failed: 'Check Pithagoras logs, or press Try again.',
};

const STOP_WORDS = new Set([
  'stop',
  'wait',
  'cancel',
  'abort',
  'halt',
  'hold on',
  'nevermind',
]);

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) {
      options.url = argv[i + 1];
      i++;
    } else if (argv[i] === '--secret' && argv[i + 1] !== undefined) {
      options.secret = argv[i + 1];
      i++;
    } else if (argv[i] === '--timeout' && argv[i + 1]) {
      options.timeoutMs = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--ceiling' && argv[i + 1]) {
      options.ceilingMs = Number(argv[i + 1]);
      i++;
    }
  }
  return options;
}

function resolveConfig(options = {}) {
  const url = options.url || process.env.PITHAGORAS_URL || process.env.PORTAL_URL || 'http://127.0.0.1:4180/';
  const secret = options.secret !== undefined
    ? options.secret
    : (process.env.PITHAGORAS_SECRET || process.env.PORTAL_SECRET || process.env.PITH_SECRET || '');
  const timeoutMs = options.timeoutMs || Number(process.env.PITHAGORAS_TIMEOUT) || DEFAULT_TIMEOUT_MS;
  const ceilingMs = options.ceilingMs || timeoutMs || DEFAULT_CEILING_MS;

  return { url, secret, timeoutMs, ceilingMs };
}

function failure(code, customMessage, customHint) {
  return {
    type: 'result',
    ok: false,
    error: {
      code,
      message: customMessage || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.failed,
      hint: customHint || DEFAULT_HINTS[code] || DEFAULT_HINTS.failed,
    },
  };
}

function redact(text, secret) {
  if (typeof text !== 'string' || !secret) return text;
  return text.split(secret).join('[REDACTED]');
}

// Bare stop words (stop, wait, cancel, etc.) abort a Pithagoras run.
// Wrap learner text so a bare stop word reaches the webhook wrapped and never raw.
function wrapIfStopWord(text) {
  if (typeof text !== 'string') return text;
  const prefixMatch = text.match(/^(\[sent from [^\]]+\]\s*)(.*)$/s);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  const content = prefixMatch ? prefixMatch[2] : text;

  const stripped = content.trim();
  const normalized = stripped.toLowerCase().replace(/^[!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~]+|[!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~]+$/g, '');

  if (STOP_WORDS.has(normalized)) {
    const wrapped = `The learner says: "${stripped}"`;
    return prefix ? `${prefix}${wrapped}` : wrapped;
  }
  return text;
}

// Refusals returned as an HTTP 200 with refusal text must not be treated as a successful reply.
function isRefusal(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed === 'Stopped.' || trimmed === 'Nothing running.') return true;
  if (/^I only talk to people I have been introduced to/i.test(trimmed)) return true;
  return false;
}

function postWebhook(targetUrl, secret, payload, { timeoutMs, ceilingMs } = {}) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      resolve(failure('unreachable'));
      return;
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const data = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    if (secret) {
      headers['X-Portal-Secret'] = secret;
    }

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers,
    };

    const startTime = Date.now();
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        req.destroy();
        finish(failure('timeout'));
      }, timeoutMs);
    }

    const req = transport.request(reqOptions, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        const status = res.statusCode;

        if (status === 401) {
          finish(failure('unauthorised'));
          return;
        }

        if (status === 404 || status === 405) {
          finish(failure('unreachable'));
          return;
        }

        if (status === 500) {
          let errorMsg = '';
          try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.error) errorMsg = parsed.error;
          } catch {}
          if (errorMsg.includes('900s') || errorMsg.includes('timeout') || errorMsg.includes('did not finish')) {
            finish(failure('timeout'));
          } else {
            finish(failure('failed'));
          }
          return;
        }

        // For check operations, a 400 with "message required" means the secret was validated
        if (status === 400) {
          let errorMsg = '';
          try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.error) errorMsg = parsed.error;
          } catch {}
          if (errorMsg === 'message required') {
            finish({ ok: true, probeAccepted: true });
            return;
          }
          finish(failure('failed'));
          return;
        }

        if (status === 200) {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            finish(failure('failed'));
            return;
          }

          const reply = parsed && parsed.reply !== undefined ? parsed.reply : '';
          if (isRefusal(reply)) {
            finish(failure('unauthorised'));
            return;
          }

          finish({ ok: true, data: parsed, reply });
          return;
        }

        finish(failure('failed'));
      });
    });

    req.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      if (timedOut) {
        finish(failure('timeout'));
        return;
      }

      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        finish(failure('unreachable'));
        return;
      }

      // Connection dropped / closed unexpectedly at or near ceiling
      const isDropped = err.code === 'ECONNRESET' ||
        err.code === 'EPIPE' ||
        err.code === 'ETIMEDOUT' ||
        (err.message && (err.message.includes('socket hang up') || err.message.includes('prematurely close')));

      if (isDropped) {
        finish(failure('timeout'));
        return;
      }

      finish(failure('unreachable'));
    });

    req.write(data);
    req.end();
  });
}

async function handleCheck(config) {
  // Check tests that the endpoint is reachable and the secret works.
  // Sends an empty message probe.
  const result = await postWebhook(config.url, config.secret, { message: '' }, {
    timeoutMs: config.timeoutMs,
    ceilingMs: config.ceilingMs,
  });

  if (!result.ok) {
    return result;
  }

  return {
    type: 'result',
    ok: true,
    permissions: PITHAGORAS_PERMISSIONS,
  };
}

async function handlePrime(config, request) {
  const session = crypto.randomUUID();
  const instruction = request.instruction || '';

  const result = await postWebhook(config.url, config.secret, {
    message: instruction,
    session,
  }, {
    timeoutMs: config.timeoutMs,
    ceilingMs: config.ceilingMs,
  });

  if (!result.ok) {
    return result;
  }

  return {
    type: 'result',
    ok: true,
    session,
  };
}

async function handleSend(config, request) {
  const session = request.session || '';
  const text = wrapIfStopWord(request.text || '');

  const result = await postWebhook(config.url, config.secret, {
    message: text,
    session,
  }, {
    timeoutMs: config.timeoutMs,
    ceilingMs: config.ceilingMs,
  });

  if (!result.ok) {
    return result;
  }

  return {
    type: 'result',
    ok: true,
    text: result.reply,
  };
}

async function handleRequest(request, options = {}) {
  const config = resolveConfig(options);

  if (!request || typeof request !== 'object' || typeof request.op !== 'string') {
    return failure('failed');
  }

  if (request.op === 'check') {
    return handleCheck(config);
  }

  if (request.op === 'prime') {
    return handlePrime(config, request);
  }

  if (request.op === 'send') {
    return handleSend(config, request);
  }

  return failure('failed');
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const config = resolveConfig(options);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', async () => {
    let request;
    try {
      request = JSON.parse(input);
    } catch {
      process.stdout.write(JSON.stringify(failure('failed')) + '\n');
      return;
    }

    const result = await handleRequest(request, options);
    const output = JSON.stringify(result);
    process.stdout.write(redact(output, config.secret) + '\n');
  });
}

module.exports = {
  PITHAGORAS_PERMISSIONS,
  DEFAULT_MESSAGES,
  DEFAULT_HINTS,
  STOP_WORDS,
  wrapIfStopWord,
  isRefusal,
  handleRequest,
  resolveConfig,
};
