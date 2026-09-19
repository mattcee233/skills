'use strict';
// Session start, harness detection, address binding, URL reply, and outcome recording.
// Node built-ins only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getProfile } = require('./profiles');
const { readConfig, recordOutcome } = require('./setup');
const { startServer } = require('./server');
const { parseFlags } = require('./flags');

const QUESTION_HARNESS = 'Which application or harness are you running inside: Claude Code, Antigravity, pi, Pithagoras, or other?';

const DISPLAY_NAMES = {
  'claude-code': 'Claude Code',
  antigravity: 'Antigravity',
  pi: 'pi',
  pithagoras: 'Pithagoras',
  other: 'Other',
};

function hasClaudeCodeMarkers(env) {
  if (!env || typeof env !== 'object') return false;
  return env.CLAUDECODE === '1' || Boolean(env.CLAUDE_CODE_ENTRYPOINT) || Boolean(env.CLAUDE_CODE_SESSION_ATTENDED);
}

// The variables pi sets in the shell it gives its agent (checked on pi 0.85). A Pithagoras instance
// runs pi, so it has these too. Named one by one: other tools' PI_ variables must not count.
const PI_VARIABLES = ['PI_CODING_AGENT', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL'];

function hasPiMarkers(env) {
  if (!env || typeof env !== 'object') return false;
  return PI_VARIABLES.some((key) => Boolean(env[key]));
}

// Only Pithagoras adds these; plain pi never sets them.
function hasPithagorasMarkers(env) {
  if (!env || typeof env !== 'object') return false;
  if (env.AGENT_HOME || env.CHANNELS_DIR || env.WORKSPACE_ROOT) return true;
  return Object.keys(env).some((key) => key.startsWith('PORTAL_'));
}

function hasAntigravityMarkers(env) {
  if (!env || typeof env !== 'object') return false;
  return Object.keys(env).some((key) => key.startsWith('ANTIGRAVITY_') || key.startsWith('JETSKI_'));
}

function detectHarness({ selfReport, env = process.env }) {
  if (!selfReport || typeof selfReport !== 'object') {
    return { resolved: false, inconclusive: true, question: QUESTION_HARNESS };
  }

  const reported = (selfReport.harness || '').trim().toLowerCase();
  const reason = (selfReport.reason || '').trim();

  if (reported === 'other' || !reported) {
    return { resolved: false, inconclusive: true, question: QUESTION_HARNESS };
  }

  const marked = {
    'claude-code': hasClaudeCodeMarkers(env),
    antigravity: hasAntigravityMarkers(env),
    pi: hasPiMarkers(env),
    pithagoras: hasPithagorasMarkers(env),
  };
  if (!Object.prototype.hasOwnProperty.call(marked, reported)) {
    // Unrecognised string reported
    return { resolved: false, inconclusive: true, question: QUESTION_HARNESS };
  }

  // A marker that belongs to a different harness is a disagreement. Pithagoras runs pi, so its
  // pi markers are expected; but pi markers with none of Pithagoras's own mean plain pi, and
  // Pithagoras's own markers mean it is not plain pi.
  const conflicts = {
    'claude-code': marked.antigravity || marked.pi || marked.pithagoras,
    antigravity: marked['claude-code'] || marked.pi || marked.pithagoras,
    pi: marked['claude-code'] || marked.antigravity || marked.pithagoras,
    pithagoras: marked['claude-code'] || marked.antigravity || (marked.pi && !marked.pithagoras),
  };
  if (conflicts[reported]) {
    return { resolved: false, conflict: true, question: QUESTION_HARNESS };
  }

  // Resolved!
  const name = DISPLAY_NAMES[reported] || reported;
  const assumption = reason
    ? `Assuming ${name} (${reason}).`
    : `Assuming ${name}.`;

  return {
    resolved: true,
    harness: reported,
    profile: getProfile(reported),
    assumption,
  };
}

const net = require('node:net');

function blockList(subnets) {
  const list = new net.BlockList();
  for (const [network, prefix, family] of subnets) list.addSubnet(network, prefix, family);
  return list;
}

const LOCAL_NETWORKS = blockList([
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
]);

function getPrivateAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const netInfo of interfaces[name]) {
      if (netInfo.family === 'IPv4' && !netInfo.internal) {
        if (LOCAL_NETWORKS.check(netInfo.address, 'ipv4') && netInfo.address !== '127.0.0.1') {
          addresses.push(netInfo.address);
        }
      }
    }
  }
  return [...new Set(addresses)];
}

function determineBindOptions({ profile, addresses }) {
  const addrs = addresses !== undefined ? addresses : getPrivateAddresses();

  // Remote harness (e.g. Pithagoras)
  if (profile && profile.remote === true) {
    if (addrs.length > 1) {
      return {
        canOfferLoopback: false,
        mode: 'network',
        mustAskAddress: true,
        addresses: addrs,
        question: `Several private network addresses were found (${addrs.join(', ')}). Which address should the server bind to?`,
      };
    }
    const chosen = addrs.length === 1 ? addrs[0] : null;
    return {
      canOfferLoopback: false,
      mode: 'network',
      mustAskAddress: false,
      addresses: addrs,
      bind: { mode: 'network', ...(chosen ? { address: chosen } : {}) },
    };
  }

  // Unrecognised harness (no profile or other)
  if (!profile || profile.id === 'other') {
    return {
      canOfferLoopback: true,
      defaultChoice: null,
      mustAskMode: true,
      question: 'Which address should the server bind to: this computer only, or other devices on your network?',
      addresses: addrs,
    };
  }

  // Desktop harness (e.g. Claude Code, Antigravity)
  return {
    canOfferLoopback: true,
    defaultChoice: 'loopback',
    bind: { mode: 'loopback' },
    question: 'Which address should the server bind to: this computer only [default], or other devices on your network?',
    addresses: addrs,
  };
}

function resolveBind({ mode = 'loopback', address = null, addresses = null } = {}) {
  if (mode === 'loopback') {
    return { mode: 'loopback' };
  }
  if (mode === 'network') {
    if (address) {
      return { mode: 'network', address };
    }
    const addrs = addresses !== undefined && addresses !== null ? addresses : getPrivateAddresses();
    if (addrs.length === 1) {
      return { mode: 'network', address: addrs[0] };
    }
    if (addrs.length > 1) {
      throw new Error(`Multiple private addresses available (${addrs.join(', ')}); specify an address.`);
    }
    throw new Error('No private network address available to bind.');
  }
  throw new Error(`Unknown bind mode "${mode}"`);
}

function formatLessonUrl({ port, token, lesson, bindMode = 'loopback', bindAddress = null }) {
  const cleanLesson = (lesson || '').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
  const host = bindMode === 'network' && bindAddress ? bindAddress : 'localhost';
  return `http://${host}:${port}/${cleanLesson}#t=${token}`;
}

const http = require('node:http');

function queryServerStatus(port, token) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/handshake',
        method: 'GET',
        headers: { 'X-Teach-Token': token },
        timeout: 2000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

function formatStatusVerdict(status) {
  if (!status || typeof status !== 'object') {
    return 'The teaching server could not be reached.';
  }
  if (status.state === 'interactive') {
    return 'chat is ready';
  }
  if (status.state === 'pending') {
    return 'still connecting';
  }
  if (status.state === 'static' || status.state === 'error') {
    const msg = status.message || 'Chat not connected.';
    const hint = status.hint ? ` ${status.hint}` : '';
    return `${msg}${hint}`.trim();
  }
  return 'Chat not connected.';
}

async function pollLauncherStatus({
  port,
  token,
  maxWaitMs = 45000,
  pollIntervalMs = 500,
  queryFn = queryServerStatus,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const status = await queryFn(port, token);
    if (status) {
      if (status.state === 'interactive') {
        return {
          state: 'interactive',
          verdict: 'chat is ready',
          raw: status,
        };
      }
      if (status.state === 'static') {
        return {
          state: 'static',
          reason: status.reason || null,
          hint: status.hint || null,
          verdict: formatStatusVerdict(status),
          raw: status,
        };
      }
      if (status.state === 'error') {
        return {
          state: 'error',
          reason: 'error',
          hint: status.hint || null,
          verdict: formatStatusVerdict(status),
          raw: status,
        };
      }
    }
    await sleepFn(pollIntervalMs);
  }

  return {
    state: 'pending',
    verdict: 'still connecting',
    raw: { state: 'pending' },
  };
}

function recordSessionOutcome(workspace, { status, reason, hint, cli }) {
  let recordStatus = null;
  let recordHint = null;

  if (status === 'ok' || status === 'interactive') {
    recordStatus = 'ok';
    recordHint = null;
  } else if (status === 'declined') {
    recordStatus = 'declined';
    recordHint = null;
  } else if (status === 'no-node') {
    recordStatus = 'no-node';
    recordHint = hint || null;
  } else if (reason === 'not-logged-in' || status === 'login-failed') {
    recordStatus = 'login-failed';
    recordHint = hint || null;
  }

  // If not one of the allowed recorded statuses, skip recording
  if (!recordStatus) {
    return { recorded: false };
  }

  const existing = readConfig(workspace);
  const keptCli = existing && existing.outcome ? existing.outcome.cli : null;
  const outcome = recordOutcome(workspace, { status: recordStatus, cli: cli !== undefined ? cli : keptCli, hint: recordHint });
  return { recorded: true, outcome };
}

function getSessionStartNotice(workspace) {
  const config = readConfig(workspace);
  if (!config || !config.outcome) {
    return { silent: true, notice: null, canStart: true };
  }

  const { status, hint } = config.outcome;
  if (status === 'declined') {
    return { silent: true, notice: null, canStart: false, tier: 3, reason: 'declined' };
  }
  if (status === 'no-node') {
    const notice = hint || 'Node 18 or later is required for interactive mode.';
    return { silent: false, notice, canStart: false, tier: 3, reason: 'no-node' };
  }
  if (status === 'login-failed') {
    const fix = hint ? ` ${hint}` : ' Run login inside your harness then press Retry.';
    const notice = `Chat is not connected: authentication is required.${fix}`;
    return { silent: false, notice, canStart: true, reason: 'login-failed' };
  }
  return { silent: true, notice: null, canStart: true };
}

// The lesson the URL opens: the newest lesson file, by name (they are numbered), or none yet.
function currentLesson(workspace) {
  let names;
  try {
    names = fs.readdirSync(path.join(workspace, 'lessons'));
  } catch {
    return null;
  }
  const lessons = names.filter((name) => /\.html?$/i.test(name)).sort();
  return lessons.length > 0 ? `lessons/${lessons[lessons.length - 1]}` : null;
}

// Every /teach invocation in an interactive workspace: start a fresh server, wait for the
// handshake verdict, record the outcome and build the one reply that carries the URL.
// `bind` is the learner's answer to the address question; without it the harness decides, and a
// question the learner must answer comes back as { active: false, needs: 'bind', question }.
async function startSession({
  workspace,
  harness,
  adapter,
  improvised = false,
  bind,
  lesson,
  addresses,
  pollTimeoutMs = 45000,
  pollIntervalMs = 500,
}) {
  const start = getSessionStartNotice(workspace);
  if (!start.canStart) {
    return { active: false, silent: start.silent, notice: start.notice, tier: start.tier, reason: start.reason };
  }

  const profile = getProfile(harness);
  let chosenBind = bind;
  if (!chosenBind) {
    const options = determineBindOptions({ profile, addresses });
    if (!options.bind) {
      return { active: false, needs: 'bind', question: options.question, addresses: options.addresses };
    }
    chosenBind = options.bind;
  }
  if (chosenBind.mode === 'network' && !chosenBind.address) {
    chosenBind = resolveBind({ mode: 'network', addresses });
  }

  const adapterCommand = adapter || (profile ? profile.adapter : null);
  const server = await startServer({ workspace, bind: chosenBind, adapter: adapterCommand, improvised });
  const outcome = await pollLauncherStatus({
    port: server.port,
    token: server.token,
    maxWaitMs: pollTimeoutMs,
    pollIntervalMs,
  });

  const cli = profile ? profile.cli : null;
  if (outcome.state === 'interactive') {
    recordSessionOutcome(workspace, { status: 'ok', cli });
  } else if (outcome.state === 'static' && outcome.reason === 'not-logged-in') {
    recordSessionOutcome(workspace, { status: 'login-failed', reason: outcome.reason, hint: outcome.hint, cli });
  }

  const url = formatLessonUrl({
    port: server.port,
    token: server.token,
    lesson: lesson || currentLesson(workspace) || '',
    bindMode: chosenBind.mode,
    bindAddress: chosenBind.address || null,
  });
  const reply = [start.notice, url, outcome.verdict].filter(Boolean).join('\n');

  return {
    active: true,
    server,
    url,
    status: outcome.state,
    reason: outcome.reason || null,
    verdict: outcome.verdict,
    notice: start.notice,
    reply,
  };
}

// What the agent runs. `detect`, `bind` and `notice` print one JSON line and exit. `start` prints
// one JSON line once the verdict is in, then keeps the server running until it is stopped.
//   node session.js detect --harness <id> [--reason <text>]
//   node session.js bind --harness <id>
//   node session.js notice --workspace <dir>
//   node session.js start --workspace <dir> --harness <id> [--mode loopback|network] [--address <ip>]
//                         [--adapter <json>] [--improvised true] [--lesson <path>]
async function main(argv) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

  if (command === 'detect') {
    print(detectHarness({ selfReport: flags.harness ? { harness: flags.harness, reason: flags.reason } : null }));
  } else if (command === 'bind') {
    print(determineBindOptions({ profile: getProfile(flags.harness) }));
  } else if (command === 'notice') {
    print(getSessionStartNotice(flags.workspace));
  } else if (command === 'start') {
    if (!flags.workspace || !fs.existsSync(flags.workspace)) throw new Error('--workspace must name an existing folder');
    const session = await startSession({
      workspace: flags.workspace,
      harness: flags.harness,
      adapter: flags.adapter ? JSON.parse(flags.adapter) : undefined,
      improvised: flags.improvised === 'true',
      bind: flags.mode ? { mode: flags.mode, ...(flags.address ? { address: flags.address } : {}) } : undefined,
      lesson: flags.lesson,
    });
    const { server, ...result } = session;
    print(result);
    if (!server) return;
    const stop = () => server.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } else {
    throw new Error('Usage: session.js detect|bind|notice|start [--name value ...]');
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  startSession,
  currentLesson,
  detectHarness,
  QUESTION_HARNESS,
  DISPLAY_NAMES,
  hasClaudeCodeMarkers,
  hasPiMarkers,
  hasPithagorasMarkers,
  hasAntigravityMarkers,
  getPrivateAddresses,
  determineBindOptions,
  resolveBind,
  formatLessonUrl,
  queryServerStatus,
  formatStatusVerdict,
  pollLauncherStatus,
  recordSessionOutcome,
  getSessionStartNotice,
};




