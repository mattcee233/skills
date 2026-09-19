'use strict';
// Finds the harness's own CLI (never another harness's), on PATH or in a known install folder,
// and confirms it with --version. Node built-ins only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getProfile } = require('./profiles');
const { readConfig, recordOutcome } = require('./setup');
const { parseFlags } = require('./flags');

// Where each CLI installs itself, besides PATH. Some agent processes start before an install and
// keep a stale PATH, so these folders are searched too.
const UNIX_COMMON = ['~/.local/bin', '/usr/local/bin'];
const KNOWN_FOLDERS = {
  claude: {
    win32: ['~/.local/bin', '%APPDATA%/npm'],
    unix: [...UNIX_COMMON, '/opt/homebrew/bin', '~/.claude/local'],
  },
  agy: {
    win32: [
      '%LOCALAPPDATA%/agy/bin',
      '~/.local/bin',
      '%LOCALAPPDATA%/Microsoft/WinGet/Packages/Google.AntigravityCLI_Microsoft.Winget.Source_8wekyb3d8bbwe',
      '%LOCALAPPDATA%/Microsoft/WinGet/Links',
    ],
    unix: UNIX_COMMON,
  },
  pi: {
    win32: ['%APPDATA%/npm', '~/.local/bin'],
    unix: [...UNIX_COMMON, '/opt/homebrew/bin', '~/.npm-global/bin'],
  },
};

const VERSION_PATTERN = /\d+\.\d+/;

function fileNames(cli, platform) {
  return platform === 'win32' ? [`${cli}.exe`, `${cli}.cmd`] : [cli];
}

function expandFolder(folder, { env, home }) {
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return path.normalize(
    folder.replace(/^~(?=[\\/])/, home).replace('%LOCALAPPDATA%', localAppData).replace('%APPDATA%', appData),
  );
}

// Every file the CLI is known to install to on this OS, in the order to try them.
function knownCandidates({ cli, platform = process.platform, env = process.env, home = os.homedir() }) {
  const folders = KNOWN_FOLDERS[cli];
  if (!folders) return [];
  const list = platform === 'win32' ? folders.win32 : folders.unix;
  return list.flatMap((folder) => {
    const dir = expandFolder(folder, { env, home });
    return fileNames(cli, platform).map((name) => path.join(dir, name));
  });
}

// Windows keeps app-execution aliases in WindowsApps. An old Claude Desktop registers a Claude.exe
// there that shadows `claude`, and running it opens the desktop app, so it is never a candidate.
function isDesktopShadow(file) {
  return file.split(/[\\/]/).some((part) => part.toLowerCase() === 'windowsapps');
}

function pathCandidates({ cli, platform, env }) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => fileNames(cli, platform).map((name) => path.join(dir, name))).filter((file) => !isDesktopShadow(file));
}

// On Windows npm installs a CLI as a `.cmd` shim, which Node cannot spawn without a shell (and a
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

function findOnPath(name, env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Turn a resolved command into one that spawns without a shell.
function spawnable(cli, env = process.env, platform = process.platform) {
  if (platform !== 'win32' || cli.length !== 1) return cli;
  let shim = null;
  if (/\.(cmd|bat)$/i.test(cli[0])) shim = cli[0];
  else if (!/[\\/]/.test(cli[0])) shim = findOnPath(`${cli[0]}.cmd`, env);
  return (shim && shimCommand(shim)) || cli;
}

// Runs `<command> --version` and nothing else: no login, no model turn.
function defaultProbe(command, args) {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    encoding: 'utf8',
    timeout: 10000,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return { ok: !result.error && result.status === 0, output: result.stdout || '' };
}

// Looks on PATH, then in the known install folders, and returns the first file that runs and
// prints a version. `source` says where it was found: 'path' or 'folder'.
function discoverCli({ cli, platform = process.platform, env = process.env, home = os.homedir(), probe = defaultProbe }) {
  const onPath = pathCandidates({ cli, platform, env }).map((file) => ({ file, source: 'path' }));
  const inFolder = knownCandidates({ cli, platform, env, home }).map((file) => ({ file, source: 'folder' }));
  const seen = new Set();
  for (const { file, source } of [...onPath, ...inFolder]) {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key) || !fs.existsSync(file)) continue;
    seen.add(key);
    const command = spawnable([file], env, platform);
    const result = probe(command, ['--version']);
    const version = result.output.trim().split(/\r?\n/)[0].trim();
    if (result.ok && VERSION_PATTERN.test(version)) {
      return { found: true, source, path: file, command, version };
    }
  }
  return { found: false, source: null, path: null, command: null, version: null };
}

// The first installed file, without running it. The adapters use this at every call, where the
// `--version` run of discoverCli would only add delay.
function locateCli({ cli, platform = process.platform, env = process.env, home = os.homedir() }) {
  const onPath = pathCandidates({ cli, platform, env }).map((file) => ({ file, source: 'path' }));
  const inFolder = knownCandidates({ cli, platform, env, home }).map((file) => ({ file, source: 'folder' }));
  const found = [...onPath, ...inFolder].find(({ file }) => fs.existsSync(file));
  return found ? { source: found.source, path: found.file, command: spawnable([found.file], env, platform) } : null;
}

// `claude auth status` is the only free login check any of the CLIs documents. Only its exit code
// is used: stdout holds account details, so it is never read, logged or returned.
function defaultLoginProbe(command) {
  const result = spawnSync(command[0], [...command.slice(1), 'auth', 'status'], {
    timeout: 15000,
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
  return !result.error && result.status === 0;
}

const CHECK_AGAIN_STEP = 'Tell me when you have finished and I will check again. If I still cannot find it, restart this app so it picks up the new PATH.';

// What the agent shows the learner. `line` is one short sentence; `steps` are for the learner to
// run themselves. The skill never runs an installer and never handles credentials.
function guidance(profile, state, { platform, found }) {
  if (state === 'missing') {
    const steps = profile.install[platform === 'win32' || platform === 'darwin' ? platform : 'linux'];
    return { line: `${profile.label} is not installed, so lessons cannot chat yet.`, steps: [...steps, CHECK_AGAIN_STEP] };
  }
  if (state === 'off-path') {
    const folder = path.dirname(found.path);
    return {
      line: `${profile.label} is installed in ${folder}, but this app's PATH does not list it yet (usually because it was installed after the app started), so I will use it from there.`,
      steps: ['Restart this app when convenient so the folder is on its PATH; nothing else is needed.'],
    };
  }
  if (state === 'not-logged-in') {
    return {
      line: `${profile.label} is installed but not logged in.`,
      steps: [...profile.loginSteps, 'Tell me when you have finished and I will check again.'],
    };
  }
  return { line: null, steps: [] };
}

// Discovery for a harness: find its own CLI (never another harness's), check its login where a
// free check exists, and say what the learner should do. Runs `--version` and, for Claude Code,
// `claude auth status`, and nothing else.
function assessCli({ harness, platform = process.platform, env = process.env, home = os.homedir(), probe, loginProbe = defaultLoginProbe }) {
  const profile = getProfile(harness);
  if (!profile) return { harness, cli: null, state: 'not-applicable', usable: false, login: 'unknown', line: null, steps: [] };

  const found = discoverCli({ cli: profile.cli, platform, env, home, ...(probe ? { probe } : {}) });
  const base = { harness, cli: profile.cli, path: found.path, version: found.version, login: 'unknown' };
  if (!found.found) return { ...base, state: 'missing', usable: false, ...guidance(profile, 'missing', { platform }) };

  if (profile.cli === 'claude') {
    base.login = loginProbe(found.command) ? 'logged-in' : 'not-logged-in';
    if (base.login === 'not-logged-in') return { ...base, state: 'not-logged-in', usable: false, ...guidance(profile, 'not-logged-in', { platform }) };
  }
  if (found.source === 'folder') return { ...base, state: 'off-path', usable: true, ...guidance(profile, 'off-path', { platform, found }) };
  return { ...base, state: 'ready', usable: true, line: null, steps: [] };
}

// Recording a declined install or a failed login. Each is recorded once: the first says it, and
// a repeat records nothing, so the session does not say it again. A decline is the learner's own
// decision and is never overwritten by a failed login.
function currentStatus(workspace) {
  const config = readConfig(workspace);
  return config && config.outcome ? config.outcome.status : null;
}

function recordDecline(workspace, { harness }) {
  const profile = getProfile(harness);
  if (currentStatus(workspace) === 'declined') return { recorded: false };
  return { recorded: true, outcome: recordOutcome(workspace, { status: 'declined', cli: profile ? profile.cli : null }) };
}

function recordLoginFailed(workspace, { harness }) {
  const profile = getProfile(harness);
  const status = currentStatus(workspace);
  if (status === 'declined' || status === 'login-failed') return { recorded: false };
  const hint = profile ? profile.loginHint : null;
  return { recorded: true, outcome: recordOutcome(workspace, { status: 'login-failed', cli: profile ? profile.cli : null, hint }) };
}

// What the agent runs. Each prints one JSON line.
//   node discovery.js assess --harness <id>
//   node discovery.js decline --workspace <dir> --harness <id>
//   node discovery.js login-failed --workspace <dir> --harness <id>
function main(argv) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (command === 'assess') {
    print(assessCli({ harness: flags.harness }));
  } else if (command === 'decline' || command === 'login-failed') {
    if (!flags.workspace || !fs.existsSync(flags.workspace)) throw new Error('--workspace must name an existing folder');
    print(command === 'decline' ? recordDecline(flags.workspace, { harness: flags.harness }) : recordLoginFailed(flags.workspace, { harness: flags.harness }));
  } else {
    throw new Error('Usage: discovery.js assess|decline|login-failed [--name value ...]');
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  discoverCli,
  locateCli,
  assessCli,
  knownCandidates,
  recordDecline,
  recordLoginFailed,
  shimCommand,
  findOnPath,
  spawnable,
};
