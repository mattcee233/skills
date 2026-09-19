#!/usr/bin/env node
'use strict';
// Starts the workspace server and prints one JSON line, {pid, port, token, addresses}, for
// the skill to build the lesson URL from. Runs until it is stopped.
//   node serve.js --workspace <dir> --bind loopback|network [--address <ip>]
const fs = require('node:fs');
const { startServer } = require('./server');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument "${argv[i]}"`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workspace || !fs.existsSync(args.workspace)) {
    throw new Error('--workspace must name an existing folder');
  }
  const server = await startServer({
    workspace: args.workspace,
    bind: { mode: args.bind, address: args.address },
  });
  process.stdout.write(`${JSON.stringify({ pid: process.pid, port: server.port, token: server.token, addresses: server.addresses })}\n`);

  const stop = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
