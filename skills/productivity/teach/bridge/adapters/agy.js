#!/usr/bin/env node
'use strict';
// The Antigravity (`agy`) bridge adapter: talks to the learner's own `agy` CLI.
// Implements check, prime and send according to the adapter contract:
// reads one JSON request on stdin, writes one JSON line on stdout.
//   node agy.js [--cli <path-or-json-array>] [--settings-path <path>] [--timeout <ms>]
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PERMISSIONS_FILE_DROP =
  'File reading and editing in the workspace, browser for research, and no terminal access (signalling via file drop).';

const PERMISSIONS_NARROW_TERMINAL =
  'File reading and editing in the workspace, browser for research, and terminal limited to the signalling command.';

const DEFAULT_MESSAGES = {
  missing: 'Antigravity CLI (agy) is not installed.',
  'not-logged-in': 'Antigravity CLI (agy) is not logged in.',
  unreachable: 'Antigravity CLI (agy) could not reach the server.',
  unauthorised: 'Antigravity credentials were not accepted.',
  timeout: 'Antigravity CLI (agy) took too long to reply.',
  failed: 'Antigravity CLI (agy) could not complete the request.',
};

const DEFAULT_HINTS = {
  missing:
    'Install the Antigravity CLI (agy) and restart your application, or check the known install folder (%LOCALAPPDATA%\\agy\\bin or ~/.local/bin), then press Retry.',
  'not-logged-in': 'Start agy and run /login, then press Retry.',
  unreachable: 'Check your internet connection and try again.',
  unauthorised: 'Start agy and run /login, then press Retry.',
  timeout: 'Press Try again to retry the request.',
  failed: 'Check agy output, or press Try again.',
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
    } else if (argv[i] === '--settings-path' && argv[i + 1]) {
      options.settingsPath = argv[i + 1];
      i++;
    } else if (argv[i] === '--grant-terminal') {
      options.terminalGrant = true;
    } else if (argv[i] === '--apply-terminal-grant') {
      options.applyTerminalGrant = true;
    }
  }
  return options;
}

function resolveCli(options = {}) {
  if (options.cli && options.cli.length > 0) return options.cli;
  if (process.env.AGY_CLI || process.env.ANTIGRAVITY_CLI) {
    const val = process.env.AGY_CLI || process.env.ANTIGRAVITY_CLI;
    if (val.startsWith('[')) {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {}
    }
    return [val];
  }
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const candidate1 = path.join(localAppData, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(candidate1)) return [candidate1];
    const candidate2 = path.join(os.homedir(), '.local', 'bin', 'agy.exe');
    if (fs.existsSync(candidate2)) return [candidate2];
  } else {
    const candidate1 = path.join(os.homedir(), '.local', 'bin', 'agy');
    if (fs.existsSync(candidate1)) return [candidate1];
    const candidate2 = '/usr/local/bin/agy';
    if (fs.existsSync(candidate2)) return [candidate2];
  }
  return ['agy'];
}

function resolveSettingsPath(options = {}) {
  if (options.settingsPath) return options.settingsPath;
  if (process.env.AGY_SETTINGS_PATH) return process.env.AGY_SETTINGS_PATH;
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

function hasNarrowTerminalGrant(settingsPath, options = {}) {
  if (options.terminalGrant === true) return true;
  try {
    if (!fs.existsSync(settingsPath)) {
      return false;
    }
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const allowList = parsed?.permissions?.allow;
    if (!Array.isArray(allowList)) {
      return false;
    }
    const signalRegex = /signal(?:\.|\\[.]|\w)*js/i;
    return allowList.some((rule) => typeof rule === 'string' && signalRegex.test(rule));
  } catch {
    return false;
  }
}

function applyTerminalGrant(settingsPath) {
  try {
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing = {};
    if (fs.existsSync(settingsPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
      } catch {
        existing = {};
      }
    }
    if (!existing.permissions) existing.permissions = {};
    if (!Array.isArray(existing.permissions.allow)) existing.permissions.allow = [];
    const rule = 'command(regex:node\\s+.*signal\\.js.*)';
    if (!existing.permissions.allow.includes(rule)) {
      existing.permissions.allow.push(rule);
    }
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    return true;
  } catch {
    return false;
  }
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
  if (
    combined.includes('401') ||
    combined.includes('unauthorized') ||
    combined.includes('unauthorised') ||
    combined.includes('invalid api key')
  ) {
    return failure('unauthorised');
  }
  if (
    combined.includes('fetch failed') ||
    combined.includes('econnrefused') ||
    combined.includes('enotfound') ||
    combined.includes('network') ||
    combined.includes('unreachable') ||
    combined.includes('etimedout')
  ) {
    return failure('unreachable');
  }
  if (
    combined.includes('authentication required') ||
    combined.includes('not logged in') ||
    combined.includes('auth login') ||
    combined.includes('token expired') ||
    combined.includes('auth_required') ||
    combined.includes('auth_error') ||
    combined.includes('unauthenticated')
  ) {
    return failure('not-logged-in');
  }
  return failure('failed');
}

async function handleCheck(cli, cwd, options = {}) {
  // `check` has no model turn and no login check (agy has no free auth status command).
  // Verifies that `agy --version` runs, and returns permissions text.
  const settingsPath = resolveSettingsPath(options);
  if (options.applyTerminalGrant) {
    applyTerminalGrant(settingsPath);
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cli[0], [...cli.slice(1), '--version'], {
        cwd,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
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

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

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
        const hasGrant = hasNarrowTerminalGrant(settingsPath, options);
        const permissions = hasGrant ? PERMISSIONS_NARROW_TERMINAL : PERMISSIONS_FILE_DROP;
        resolve({
          type: 'result',
          ok: true,
          permissions,
        });
      } else {
        const combined = `${stdout} ${stderr}`.toLowerCase();
        if (combined.includes('not found') || combined.includes('no such file')) {
          resolve(failure('missing'));
        } else {
          resolve(failure('failed'));
        }
      }
    });

    child.stdin.end();
  });
}

function parseAgyJsonOutput(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (l.startsWith('{') && l.endsWith('}')) {
      try {
        const parsed = JSON.parse(l);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
    }
  }
  return null;
}

async function handlePrime(cli, cwd, request, options = {}) {
  // Priming turn: read-only instruction to load context.
  // Invocations include cwd as workspace and extra-folder argument `--add-dir .`.
  // Transport result (exit code, transport status), NOT model wording, decides login success.
  const args = [
    '--add-dir', '.',
    '-p', request.instruction || '',
    '--output-format', 'json',
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
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

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

      if (code !== 0) {
        resolve(classifyError(code, stdout, stderr));
        return;
      }

      const parsed = parseAgyJsonOutput(stdout);
      if (!parsed) {
        resolve(classifyError(code, stdout, stderr));
        return;
      }

      // Check for transport-level error in JSON (e.g. status != SUCCESS and error field)
      if (parsed.status && parsed.status !== 'SUCCESS') {
        const errText = `${parsed.status} ${parsed.error || ''}`;
        resolve(classifyError(1, '', errText));
        return;
      }

      if (parsed.conversation_id && typeof parsed.conversation_id === 'string') {
        resolve({
          type: 'result',
          ok: true,
          session: parsed.conversation_id,
        });
      } else {
        resolve(failure('failed'));
      }
    });

    child.stdin.end();
  });
}

async function handleSend(cli, cwd, request, options = {}) {
  // Send turn: passes text as one argument and resumes conversation using `--conversation`.
  // Invocations include cwd as workspace and extra-folder argument `--add-dir .`.
  const args = [
    '--add-dir', '.',
    '-p', request.text || '',
    '--conversation', request.session || '',
    '--output-format', 'json',
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
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

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

      if (code !== 0) {
        resolve(classifyError(code, stdout, stderr));
        return;
      }

      const parsed = parseAgyJsonOutput(stdout);
      if (!parsed) {
        resolve(classifyError(code, stdout, stderr));
        return;
      }

      if (parsed.status && parsed.status !== 'SUCCESS') {
        const errText = `${parsed.status} ${parsed.error || ''}`;
        resolve(classifyError(1, '', errText));
        return;
      }

      const text =
        typeof parsed.response === 'string'
          ? parsed.response
          : typeof parsed.result === 'string'
            ? parsed.result
            : stdout.trim();

      resolve({
        type: 'result',
        ok: true,
        text,
      });
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
  PERMISSIONS_FILE_DROP,
  PERMISSIONS_NARROW_TERMINAL,
  DEFAULT_MESSAGES,
  DEFAULT_HINTS,
  handleRequest,
  resolveCli,
  resolveSettingsPath,
  hasNarrowTerminalGrant,
  applyTerminalGrant,
};
