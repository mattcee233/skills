#!/usr/bin/env node
'use strict';
// The Claude Code bridge adapter: talks to the learner's own `claude` CLI.
// Implements check, prime and send according to the adapter contract:
// reads one JSON request on stdin, writes one JSON line on stdout.
//   node claude-code.js [--cli <path-or-json-array>]
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const CLAUDE_PERMISSIONS =
  'File reading and editing in the workspace, browser for research, and terminal limited to the signalling command.';

const ALLOWED_TOOLS = 'Bash(node .teach/signal.js *),WebFetch,WebSearch';

const DEFAULT_MESSAGES = {
  missing: 'Claude Code is not installed.',
  'not-logged-in': 'Claude Code is not logged in.',
  unreachable: 'Claude Code could not reach the server.',
  unauthorised: 'Claude Code credentials were not accepted.',
  timeout: 'Claude Code took too long to reply.',
  failed: 'Claude Code could not complete the request.',
};

const DEFAULT_HINTS = {
  missing: 'Install Claude Code and make sure it is on your PATH, then press Retry.',
  'not-logged-in': 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.',
  unreachable: 'Check your internet connection and try again.',
  unauthorised: 'Run "claude auth login" in your terminal, or "/login" inside Claude Code, then press Retry.',
  timeout: 'Press Try again to retry the request.',
  failed: 'Check Claude Code output, or press Try again.',
};

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cli' && argv[i + 1]) {
      const val = argv[i + 1];
      if (val.startsWith('[')) {
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed) && parsed.length > 0) options.cli = parsed;
        } catch {}
      }
      if (!options.cli) options.cli = [val];
      i++;
    } else if (argv[i] === '--timeout' && argv[i + 1]) {
      options.timeoutMs = Number(argv[i + 1]);
      i++;
    }
  }
  return options;
}

function resolveCli(options) {
  if (options.cli && options.cli.length > 0) return options.cli;
  if (process.env.CLAUDE_CLI) {
    const val = process.env.CLAUDE_CLI;
    if (val.startsWith('[')) {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {}
    }
    return [val];
  }
  const isWindows = process.platform === 'win32';
  const candidate = isWindows
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
    : path.join(os.homedir(), '.local', 'bin', 'claude');
  if (fs.existsSync(candidate)) return [candidate];
  return ['claude'];
}

function failure(code) {
  return {
    type: 'result',
    ok: false,
    error: {
      code,
      message: DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.failed,
      hint: DEFAULT_HINTS[code] || DEFAULT_HINTS.failed,
    },
  };
}

function classifyError(code, stdout = '', stderr = '') {
  const combined = `${stdout} ${stderr}`.toLowerCase();
  if (combined.includes('401') || combined.includes('unauthorized') || combined.includes('unauthorised') || combined.includes('invalid api key')) {
    return failure('unauthorised');
  }
  if (combined.includes('fetch failed') || combined.includes('econnrefused') || combined.includes('enotfound') || combined.includes('network') || combined.includes('unreachable') || combined.includes('etimedout')) {
    return failure('unreachable');
  }
  if (combined.includes('not logged in') || combined.includes('authentication required') || combined.includes('auth login') || combined.includes('token expired')) {
    return failure('not-logged-in');
  }
  return failure('failed');
}

async function handleCheck(cli, cwd, options = {}) {
  // Check auth status: `claude auth status`.
  // The output contains account details (email, org) and is NEVER logged, piped or returned.
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cli[0], [...cli.slice(1), 'auth', 'status'], {
        cwd,
        env: process.env,
        shell: false,
        stdio: 'ignore', // Never read or log auth status output
      });
    } catch {
      resolve(failure('missing'));
      return;
    }

    let settled = false;
    let timer;
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve(failure('timeout'));
      }, options.timeoutMs);
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err.code === 'ENOENT') resolve(failure('missing'));
      else resolve(failure('failed'));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({
          type: 'result',
          ok: true,
          permissions: CLAUDE_PERMISSIONS,
        });
      } else {
        resolve(failure('not-logged-in'));
      }
    });
  });
}

async function handlePrime(cli, cwd, request, options = {}) {
  const session = crypto.randomUUID();
  const args = [
    '-p',
    request.instruction || '',
    '--output-format', 'json',
    '--session-id', session,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ALLOWED_TOOLS,
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cli[0], [...cli.slice(1), ...args], {
        cwd,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve(failure('failed'));
      return;
    }

    let settled = false;
    let timer;
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve(failure('timeout'));
      }, options.timeoutMs);
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err.code === 'ENOENT') resolve(failure('missing'));
      else resolve(failure('failed'));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({
          type: 'result',
          ok: true,
          session,
        });
      } else {
        resolve(classifyError(code, stdout, stderr));
      }
    });

    child.stdin.end();
  });
}

async function handleSend(cli, cwd, request, options = {}) {
  const args = [
    '-p',
    request.text || '',
    '--output-format', 'json',
    '--resume', request.session || '',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ALLOWED_TOOLS,
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cli[0], [...cli.slice(1), ...args], {
        cwd,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve(failure('failed'));
      return;
    }

    let settled = false;
    let timer;
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve(failure('timeout'));
      }, options.timeoutMs);
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err.code === 'ENOENT') resolve(failure('missing'));
      else resolve(failure('failed'));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        let text = stdout.trim();
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.result === 'string') text = parsed.result;
        } catch {
          for (const line of stdout.split('\n')) {
            try {
              const p = JSON.parse(line.trim());
              if (p && typeof p.result === 'string') {
                text = p.result;
                break;
              }
            } catch {}
          }
        }
        resolve({
          type: 'result',
          ok: true,
          text,
        });
      } else {
        resolve(classifyError(code, stdout, stderr));
      }
    });

    child.stdin.end();
  });
}

async function handleRequest(request, options = {}) {
  const cli = resolveCli(options);
  const cwd = process.cwd();

  if (!request || typeof request !== 'object' || typeof request.op !== 'string') {
    return failure('failed');
  }

  if (request.op === 'check') {
    return handleCheck(cli, cwd, options);
  }

  if (request.op === 'prime') {
    return handlePrime(cli, cwd, request, options);
  }

  if (request.op === 'send') {
    return handleSend(cli, cwd, request, options);
  }

  return failure('failed');
}


if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
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
    process.stdout.write(JSON.stringify(result) + '\n');
  });
}

module.exports = {
  CLAUDE_PERMISSIONS,
  DEFAULT_MESSAGES,
  DEFAULT_HINTS,
  handleRequest,
  resolveCli,
};
