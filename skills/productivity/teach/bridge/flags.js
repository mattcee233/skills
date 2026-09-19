'use strict';
// Reads the "--name value" pairs of the commands an agent runs into an object.
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`Expected "--name value", got "${argv[i]}"`);
    }
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}

module.exports = { parseFlags };
