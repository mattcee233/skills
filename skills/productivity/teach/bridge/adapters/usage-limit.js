'use strict';
// A used-up usage allowance, recognised from an engine's own words. The adapters answer it with
// a fixed message and hint on the `failed` code, so it reaches the page through the normal error
// path without a new code and without passing on any of the engine's text.
const USAGE_LIMIT_PATTERN =
  /usage limit|limit reached|hit your limit|rate limit|quota|resource_exhausted|too many requests|\b429\b|out of (usage|credits)|credits? (exhausted|depleted|run out)/i;

function isUsageLimit(...texts) {
  return USAGE_LIMIT_PATTERN.test(texts.filter((text) => typeof text === 'string').join(' '));
}

function usageLimitFailure(engine, allowance) {
  return {
    type: 'result',
    ok: false,
    error: {
      code: 'failed',
      message: `${engine} usage limit reached.`,
      hint: `Your ${allowance} has run out for now. Wait for it to renew, then press Try again.`,
    },
  };
}

module.exports = { isUsageLimit, usageLimitFailure };
