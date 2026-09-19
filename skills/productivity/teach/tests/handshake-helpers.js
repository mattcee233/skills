'use strict';
// Shared by the handshake tests: a real server that runs the start-of-session handshake
// against a scripted fake adapter (no session given up front, so it must earn one).
const { startServer } = require('../bridge/server');
const { makeWorkspace, get, post } = require('./helpers');
const { fakeAdapter } = require('./fake-adapter-client');

const ok = (extra = {}) => ({ type: 'result', ok: true, ...extra });
const fail = (code, extra = {}) => ({ type: 'result', ok: false, error: { code, message: `${code} happened`, ...extra } });
const PERMISSIONS = 'Reads and edits files in the workspace; runs only the signalling command.';
const PASSING = { check: ok({ permissions: PERMISSIONS }), prime: ok({ session: 'sess-1' }), send: ok({ text: 'A reply.' }) };

async function withHandshake(t, script, options = {}) {
  const ws = makeWorkspace({
    'MISSION.md': 'Learn loops.',
    'lessons/0001-loops.html': '<!doctype html><html><body><h1>Loops</h1></body></html>',
    ...(options.files || {}),
  });
  const adapter = fakeAdapter(script);
  const server = await startServer({ workspace: ws.dir, bind: { mode: 'loopback' }, adapter: adapter.command, ...options.server });
  t.after(async () => {
    await server.close();
    adapter.cleanup();
    ws.cleanup();
  });
  return { ws, server, adapter };
}

const handshakeState = async (server) => (await get(server, '/handshake')).json();

// Poll the handshake route until the state is no longer pending (or matches `until`).
async function awaitVerdict(server, until = (state) => state.state !== 'pending', ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = await handshakeState(server);
    if (until(state)) return state;
    if (Date.now() > deadline) throw new Error(`handshake still ${JSON.stringify(state)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const retryHandshake = (server) => post(server, '/retry', {});

module.exports = { ok, fail, PERMISSIONS, PASSING, withHandshake, handshakeState, awaitVerdict, retryHandshake };
