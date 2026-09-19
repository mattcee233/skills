#!/usr/bin/env node
'use strict';
// The Pithagoras bridge adapter: talks to the learner's own `pi` CLI via child_process.
// Implements check, prime and send according to the adapter contract:
// reads one JSON request on stdin, writes one JSON line on stdout.
//   node pithagoras.js [--cli <path-or-json-array>] [--timeout <ms>]
//
// Web research goes through the `pi-web-access` package. Its search results must come
// straight back to the agent, so every turn appends WEB_SEARCH_INSTRUCTION, which tells the
// agent to pass `workflow: "none"` on each web_search call. The learner's global
// ~/.pi/web-search.json is never read or written.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const WEB_ACCESS_PACKAGE = 'pi-web-access';

const WEB_SEARCH_INSTRUCTION =
  'When you call web_search, always pass workflow: "none" so the results come straight back to you. ' +
  'Never use the summary-review or auto-summary workflows, and never wait on a search curator.';

const PITHAGORAS_PERMISSIONS_WEB =
  "The agent runs with its process's full permissions and has no approval prompts. It can search the web and fetch pages through the pi-web-access package.";

const PITHAGORAS_PERMISSIONS_NO_WEB =
  "The agent runs with its process's full permissions and has no approval prompts. Web research is not available because the pi-web-access package is not installed.";

const PITHAGORAS_PERMISSIONS = PITHAGORAS_PERMISSIONS_NO_WEB;

const DEFAULT_MESSAGES = {
  missing: 'pi CLI is not installed.',
  'not-logged-in': 'pi has no credentials for its model provider.',
  unreachable: 'pi could not reach its model provider.',
  unauthorised: 'pi credentials were not accepted.',
  timeout: 'pi took too long to reply.',
  failed: 'pi could not complete the request.',
};

const DEFAULT_HINTS = {
  missing: 'Install the pi CLI and make sure it is on your PATH, then press Retry.',
  'not-logged-in': 'Run pi and use /login, or set your provider API key, then press Retry.',
  unreachable: 'Check that your model provider is running and reachable, then press Retry.',
  unauthorised: 'Check your pi provider credentials or API key, then press Retry.',
  timeout: 'The agent may still be working in the background. Press Try again to retry.',
  failed: 'Check pi output, or press Try again.',
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 900 seconds

function parseCliValue(val) {
  if (typeof val === 'string' && val.startsWith('[')) {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  return [val];
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cli' && argv[i + 1]) {
      options.cli = parseCliValue(argv[++i]);
    } else if (argv[i] === '--timeout' && argv[i + 1]) {
      options.timeoutMs = Number(argv[++i]);
    }
  }
  return options;
}

// On Windows npm installs `pi` as a `.cmd` shim, which Node cannot spawn without a shell (and a
// shell would put learner text through cmd.exe quoting). Read the shim for the script it runs
// and run that with Node directly. Returns null when the file is not such a shim.
function shimCommand(shimPath) {
  let source;
  try {
    source = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const match = source.match(/"%dp0%[\\/]+([^"]+?\.m?js)"/i);
  if (!match) return null;
  const script = path.join(path.dirname(shimPath), match[1]);
  return fs.existsSync(script) ? [process.execPath, script] : null;
}

function findOnPath(name) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Turn a resolved command into one that spawns without a shell.
function spawnable(cli) {
  if (process.platform !== 'win32' || cli.length !== 1) return cli;
  let shim = null;
  if (/\.(cmd|bat)$/i.test(cli[0])) shim = cli[0];
  else if (!/[\\/]/.test(cli[0])) shim = findOnPath(`${cli[0]}.cmd`);
  return (shim && shimCommand(shim)) || cli;
}

function resolveCli(options = {}) {
  if (options.cli && options.cli.length > 0) return spawnable(options.cli);
  const fromEnv = process.env.PI_CLI || process.env.PITHAGORAS_CLI;
  if (fromEnv) return spawnable(parseCliValue(fromEnv));
  if (process.platform === 'win32') {
    const roamingAppData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const npmShim = path.join(roamingAppData, 'npm', 'pi.cmd');
    if (fs.existsSync(npmShim)) return spawnable([npmShim]);
    const localExe = path.join(os.homedir(), '.local', 'bin', 'pi.exe');
    if (fs.existsSync(localExe)) return [localExe];
  } else {
    for (const candidate of [path.join(os.homedir(), '.local', 'bin', 'pi'), '/usr/local/bin/pi']) {
      if (fs.existsSync(candidate)) return [candidate];
    }
  }
  return spawnable(['pi']);
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

// Map pi's own words for a failure onto the closed error set. `not-logged-in` is judged here,
// from the prime turn, because `pi auth check` needs a provider and local providers have none.
function classifyError(text = '') {
  const combined = String(text).toLowerCase();
  if (
    combined.includes('no api key') ||
    combined.includes('credentials_not_configured') ||
    combined.includes('not logged in') ||
    combined.includes('/login') ||
    combined.includes('no credentials') ||
    combined.includes('token expired')
  ) {
    return failure('not-logged-in');
  }
  if (
    combined.includes('401') ||
    combined.includes('403') ||
    combined.includes('unauthorized') ||
    combined.includes('unauthorised') ||
    combined.includes('invalid api key')
  ) {
    return failure('unauthorised');
  }
  if (
    combined.includes('fetch failed') ||
    combined.includes('connection error') ||
    combined.includes('econnrefused') ||
    combined.includes('enotfound') ||
    combined.includes('network') ||
    combined.includes('unreachable') ||
    combined.includes('etimedout')
  ) {
    return failure('unreachable');
  }
  return failure('failed');
}

// A learner message that starts with `@` is read by pi as a file to attach, even after `--`.
function safeMessage(text) {
  const value = typeof text === 'string' ? text : '';
  return value.trimStart().startsWith('@') ? `The learner says: ${value}` : value;
}

// Read `pi --mode json` output (one event per line). The reply is the text of the last
// assistant message in `agent_end`; a stopReason of error or aborted is a failed turn.
function parseTurn(stdout) {
  let lastAssistant = null;
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'agent_end' && Array.isArray(event.messages)) {
      const assistants = event.messages.filter((m) => m && m.role === 'assistant');
      if (assistants.length > 0) lastAssistant = assistants[assistants.length - 1];
    } else if (event.type === 'message_end' && event.message && event.message.role === 'assistant' && !lastAssistant) {
      lastAssistant = event.message;
    }
  }
  if (!lastAssistant) return { error: 'no reply' };
  if (lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted') {
    return { error: lastAssistant.errorMessage || lastAssistant.stopReason };
  }
  const content = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
  const text = content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
  return { text };
}

// Run the pi CLI once. Resolves { kind: 'exit', code, stdout, stderr }, or { kind: 'missing' },
// { kind: 'timeout' } or { kind: 'spawn-failed' }.
function runPi(cli, cwd, args, timeoutMs) {
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
      resolve({ kind: 'missing' });
      return;
    }

    let settled = false;
    let timer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        settle({ kind: 'timeout' });
      }, timeoutMs);
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => settle({ kind: err.code === 'ENOENT' ? 'missing' : 'spawn-failed' }));
    child.on('close', (code) => settle({ kind: 'exit', code, stdout, stderr }));
    child.stdin.end();
  });
}

function turnArgs(message, session) {
  return [
    '-p',
    '--mode',
    'json',
    '--session-id',
    session,
    '--append-system-prompt',
    WEB_SEARCH_INSTRUCTION,
    '--',
    message,
  ];
}

async function runTurn(cli, cwd, message, session, options) {
  const run = await runPi(cli, cwd, turnArgs(message, session), options.timeoutMs);
  if (run.kind === 'missing') return failure('missing');
  if (run.kind === 'timeout') return failure('timeout');
  if (run.kind === 'spawn-failed') return failure('failed');
  if (run.code !== 0) return classifyError(`${run.stdout} ${run.stderr}`);
  const turn = parseTurn(run.stdout);
  if (turn.error) return classifyError(turn.error);
  return { type: 'result', ok: true, text: turn.text };
}

// `pi list` names the installed packages; a listing that includes pi-web-access means the
// agent can research on the web.
async function handleCheck(cli, cwd, options) {
  const run = await runPi(cli, cwd, ['list'], options.timeoutMs);
  if (run.kind === 'missing') return failure('missing');
  if (run.kind === 'timeout') return failure('timeout');
  if (run.kind === 'spawn-failed' || run.code !== 0) return failure('failed');
  const hasWebAccess = run.stdout.toLowerCase().includes(WEB_ACCESS_PACKAGE);
  return {
    type: 'result',
    ok: true,
    permissions: hasWebAccess ? PITHAGORAS_PERMISSIONS_WEB : PITHAGORAS_PERMISSIONS_NO_WEB,
    hasWebAccess,
  };
}

async function handlePrime(cli, cwd, request, options) {
  const session = crypto.randomUUID();
  const result = await runTurn(cli, cwd, safeMessage(request.instruction), session, options);
  if (!result.ok) return result;
  return { type: 'result', ok: true, session };
}

async function handleSend(cli, cwd, request, options) {
  return runTurn(cli, cwd, safeMessage(request.text), request.session || '', options);
}

async function handleRequest(request, options = {}) {
  const cli = resolveCli(options);
  const cwd = process.cwd();
  const opts = { ...options, timeoutMs: options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_TIMEOUT_MS };

  if (!request || typeof request !== 'object' || typeof request.op !== 'string') {
    return failure('failed');
  }
  if (request.op === 'check') return handleCheck(cli, cwd, opts);
  if (request.op === 'prime') return handlePrime(cli, cwd, request, opts);
  if (request.op === 'send') return handleSend(cli, cwd, request, opts);
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
  PITHAGORAS_PERMISSIONS,
  PITHAGORAS_PERMISSIONS_WEB,
  PITHAGORAS_PERMISSIONS_NO_WEB,
  WEB_SEARCH_INSTRUCTION,
  DEFAULT_MESSAGES,
  DEFAULT_HINTS,
  safeMessage,
  parseTurn,
  handleRequest,
  resolveCli,
  shimCommand,
};
