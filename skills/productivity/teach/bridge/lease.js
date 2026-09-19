'use strict';
// The interactive lease: only one page at a time has live chat. A page is a tab id, announced when
// it opens the event stream; a tab may have more than one stream at a moment (same-tab navigation
// opens the next page's stream before the old one closes). Node built-ins only.
//
// The first tab to connect while nobody holds the lease holds it. A different tab is told it is not
// interactive and takes over only by asking. When the holder's last stream closes the lease is freed
// after a grace period (so the next page of the same tab, or a network blip, keeps it) and the other
// pages are nudged with `lease-free`; nothing is ever claimed automatically.
const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const GRACE_MS = 5000;

function createLease({ graceMs = GRACE_MS } = {}) {
  let holder = null;
  let releaseTimer = null;
  // Each tab's open streams, as functions that write one event to that stream.
  const streams = new Map();

  const sendToTab = (tab, event, data) => {
    for (const send of streams.get(tab) || []) send(event, data);
  };

  const cancelRelease = () => {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  };

  const release = () => {
    releaseTimer = null;
    holder = null;
    for (const tab of streams.keys()) sendToTab(tab, 'lease-free', {});
  };

  return {
    // A page opened its event stream. Tells that stream where it stands and returns a function to call
    // when the stream closes.
    connect(tab, send) {
      if (!streams.has(tab)) streams.set(tab, new Set());
      streams.get(tab).add(send);
      if (holder === null || holder === tab) {
        holder = tab;
        cancelRelease();
        send('lease', { state: 'interactive' });
      } else {
        send('lease', { state: 'not-interactive' });
      }
      return () => {
        const open = streams.get(tab);
        open.delete(send);
        if (open.size) return;
        streams.delete(tab);
        if (holder !== tab) return;
        releaseTimer = setTimeout(release, graceMs);
        releaseTimer.unref();
      };
    },

    // The page asked for the lease. Only a page with an open stream can take it. The old holder is
    // told it was displaced, and the new one that it is interactive, in one step.
    take(tab) {
      if (!streams.has(tab)) return false;
      const previous = holder;
      holder = tab;
      cancelRelease();
      if (previous !== tab) {
        if (previous !== null) sendToTab(previous, 'displaced', {});
        sendToTab(tab, 'lease', { state: 'interactive' });
      }
      return true;
    },

    hasHolder() {
      return holder !== null;
    },

    isHolder(tab) {
      return tab !== null && holder === tab;
    },

    close() {
      cancelRelease();
    },
  };
}

module.exports = { createLease, TAB_ID_PATTERN };
