'use strict';
// Test fixture: a bridge server run as its own process, as a leftover from an earlier session.
const { startServer } = require('../bridge/server');

startServer({ workspace: process.argv[2], bind: { mode: 'loopback' } }).then((server) => {
  process.stdout.write(`ready ${server.port}\n`);
  setInterval(() => {}, 1000);
});
