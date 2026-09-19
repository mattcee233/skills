'use strict';
// Improvised adapters helper module (Ticket 27).
// Manages detection, configuration and template generation for workspace-local improvised connectors.
const fs = require('node:fs');
const path = require('node:path');

const UNREVIEWED_CONNECTOR_WARNING =
  'This connector was written by an AI for this workspace and has not been reviewed. Check what it does before you rely on it.';

// Look for a kept adapter in the workspace-local .teach/adapters/ folder.
function findKeptAdapter(workspace) {
  const configPath = path.join(workspace, '.teach', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.adapter && typeof config.adapter === 'string') {
        const full = path.isAbsolute(config.adapter) ? config.adapter : path.join(workspace, config.adapter);
        if (fs.existsSync(full)) return full;
      }
    } catch {
      // ignore invalid config
    }
  }

  const adaptersDir = path.join(workspace, '.teach', 'adapters');
  if (!fs.existsSync(adaptersDir)) return null;

  try {
    const files = fs.readdirSync(adaptersDir).filter((f) => f.endsWith('.js'));
    if (files.length > 0) {
      return path.join(adaptersDir, files[0]);
    }
  } catch {
    return null;
  }
  return null;
}

// Record an outcome (e.g. 'ok', 'declined', 'login-failed', 'no-node') into .teach/config.json.
function recordOutcome(workspace, outcome) {
  const teachDir = path.join(workspace, '.teach');
  fs.mkdirSync(teachDir, { recursive: true });
  const configPath = path.join(teachDir, 'config.json');

  let current = { version: 1 };
  if (fs.existsSync(configPath)) {
    try {
      current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      current = { version: 1 };
    }
  }

  current.version = current.version || 1;
  current.outcome = {
    status: outcome.status,
    cli: outcome.cli || null,
    date: outcome.date || new Date().toISOString(),
    ...(outcome.hint ? { hint: outcome.hint } : {}),
  };

  fs.writeFileSync(configPath, JSON.stringify(current, null, 2) + '\n');
}

// Build standard source code for a workspace-local improvised adapter adhering to the adapter contract.
function buildImprovisedAdapterSource({ engineCli, permissions, loginHint, passWorkspaceToPrime = false }) {
  const cliArrayJson = JSON.stringify(engineCli);
  const permissionsEscaped = JSON.stringify(permissions || 'Custom connector permissions.');
  const hintEscaped = JSON.stringify(loginHint || 'Authenticate with your AI engine CLI, then press Retry.');

  return `#!/usr/bin/env node
'use strict';
// Improvised adapter for custom AI engine in this workspace.
// Adheres to the teach adapter contract: stdin/stdout JSON lines, operations 'check', 'prime', 'send'.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const ENGINE_CLI = ${cliArrayJson};
const PERMISSIONS = ${permissionsEscaped};
const LOGIN_HINT = ${hintEscaped};
const PASS_WORKSPACE_TO_PRIME = ${passWorkspaceToPrime};

function sendResult(result) {
  process.stdout.write(JSON.stringify(result) + '\\n');
  process.exit(0);
}

function sendError(code, message, hint) {
  sendResult({
    type: 'result',
    ok: false,
    error: {
      code,
      message,
      ...(hint ? { hint } : {}),
    },
  });
}

function runCommand(args, cwd) {
  return new Promise((resolve) => {
    const [bin, ...rest] = ENGINE_CLI;
    const child = spawn(bin, [...rest, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function handleCheck(cwd) {
  const versionRes = await runCommand(['--version'], cwd);
  if (versionRes.code !== 0) {
    return sendError('missing', 'The engine CLI is not installed or not reachable.', 'Install the CLI and press Retry.');
  }

  const authRes = await runCommand(['--auth-status'], cwd);
  if (authRes.code !== 0) {
    return sendError('not-logged-in', 'The engine CLI is not authenticated.', LOGIN_HINT);
  }

  sendResult({
    type: 'result',
    ok: true,
    permissions: PERMISSIONS,
  });
}

async function handlePrime(cwd) {
  const primeArgs = ['--prime'];
  if (PASS_WORKSPACE_TO_PRIME) {
    primeArgs.push(cwd);
  }
  const primeRes = await runCommand(primeArgs, cwd);
  if (primeRes.code !== 0) {
    return sendError('failed', 'The engine failed to initialise session.', 'Check engine status and press Retry.');
  }

  let session = 'session-' + crypto.randomUUID();
  try {
    const parsed = JSON.parse(primeRes.stdout.trim());
    if (parsed && parsed.sessionId) session = parsed.sessionId;
  } catch {
    // use generated uuid
  }

  sendResult({
    type: 'result',
    ok: true,
    session,
  });
}

async function handleSend(request, cwd) {
  const sendRes = await runCommand(['--send', '--session', request.session, '--prompt', request.text], cwd);
  if (sendRes.code !== 0) {
    return sendError('failed', 'Failed to generate a reply.', 'Try asking again.');
  }

  let replyText = sendRes.stdout.trim();
  try {
    const parsed = JSON.parse(replyText);
    if (parsed && parsed.reply) replyText = parsed.reply;
  } catch {
    // use raw output if not json
  }

  sendResult({
    type: 'result',
    ok: true,
    text: replyText,
  });
}

async function main() {
  const cwd = process.cwd();
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let request;
  try {
    request = JSON.parse(input.trim());
  } catch {
    return sendError('failed', 'Malformed request received.');
  }

  if (request.op === 'check') {
    await handleCheck(cwd);
  } else if (request.op === 'prime') {
    await handlePrime(cwd);
  } else if (request.op === 'send') {
    await handleSend(request, cwd);
  } else {
    sendError('failed', 'Unknown operation: ' + request.op);
  }
}

main().catch((err) => {
  sendError('failed', 'Internal connector error: ' + err.message);
});
`;
}

module.exports = {
  UNREVIEWED_CONNECTOR_WARNING,
  findKeptAdapter,
  recordOutcome,
  buildImprovisedAdapterSource,
};
