'use strict';
// Test helper: creates and configures an isolated stub `agy` executable.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUB_SOURCE = path.join(__dirname, 'stub-agy.js');

function makeStubAgy(t, initialConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-stub-agy-'));
  const scriptPath = path.join(dir, 'stub-agy.js');
  const configPath = path.join(dir, 'config.json');
  const callsPath = path.join(dir, 'calls.jsonl');

  fs.copyFileSync(STUB_SOURCE, scriptPath);
  fs.writeFileSync(configPath, JSON.stringify(initialConfig));

  if (t && typeof t.after === 'function') {
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  return {
    dir,
    command: [process.execPath, scriptPath],
    cliString: JSON.stringify([process.execPath, scriptPath]),
    setConfig(nextConfig) {
      fs.writeFileSync(configPath, JSON.stringify(nextConfig));
    },
    calls() {
      try {
        const content = fs.readFileSync(callsPath, 'utf8');
        return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { makeStubAgy };
