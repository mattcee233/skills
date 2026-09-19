# Interactive Setup and Interview

Reference document for `/teach` interactive mode setup.

## Overview

Teaching workspaces can operate in **interactive mode** (served via a local web server with live widgets and agent chat) or **plain files mode** (HTML files opened locally).

## Flow in a New Workspace

1. **Mission Interview First**: The existing mission interview runs first, unchanged.
2. **Interactive Consent Question**: Ask the learner a plain yes or no:
   > "Would you like interactive mode for these lessons? (This runs a local server so you can chat with the teacher and get live updates directly on the lesson pages.)"
3. **If the learner says No**:
   - Skip every technical step (no server started, no launcher installed).
   - Record `declined` in `.teach/config.json` with `.teach/.gitignore`.
   - Leave the learner with plain files.
   - Future invocations in this workspace remain silent about interactive mode.
4. **If the learner says Yes**:
   - Setup runs once per workspace, before authoring lesson one.

## Setup Steps

### 1. Node Version Check
- Check `node --version` in the agent's own shell.
- Minimum version is **Node 18** (uses Node built-ins only, no `npm install`).
- **If Node is missing or below 18**:
  - Guide the learner through installing Node 18+ in chat for their OS:
    - **macOS**: `brew install node` or installer from https://nodejs.org
    - **Windows**: `winget install OpenJS.NodeJS.LTS` or installer from https://nodejs.org
    - **Linux**: distribution package manager or https://nodejs.org
  - Offer to check again.
  - If the learner declines or does not wish to install Node:
    - Record `no-node` in `.teach/config.json` with `.teach/.gitignore`.
    - Provide plain lesson files (Tier 3).

### 2. Machine-Local Folder (`.teach/`)
- Ensure `.teach/` folder exists.
- Write `.teach/.gitignore` containing `*` so all machine-local files stay untracked.
- **Never create or edit the learner's own root `.gitignore`**.
- Write `.teach/config.json`:
  ```json
  {
    "version": 1,
    "adapter": null,
    "cli": null,
    "outcome": {
      "status": "ok",
      "cli": null,
      "date": "2026-09-19T...",
      "hint": null
    }
  }
  ```
- Copy the launcher script to `.teach/signal.js` with execute permissions (`0755`).

### 3. Workspace Documentation
- **`AGENTS.md`**: Add or refresh the marked `## Teaching signals` block using the generator in `bridge/teaching-signals.js`. Preserves all existing content around the block.
- **`CLAUDE.md`**: Add `@AGENTS.md` import line if not already present.

## Re-trying and `/teach interactive`

- `/teach interactive` is a reserved first word.
- Alternatively, a plain request such as "try interactive mode again" or "check again".
- Resets any previously recorded outcome (`declined`, `no-node`, `login-failed`).
- Re-runs setup steps (Node check, refreshing launcher and `AGENTS.md` block) without repeating the mission interview.

## Fresh Clones

- `.teach/` is machine-local and not committed.
- In a fresh clone without `.teach/`, the committed `AGENTS.md` block instructs the agent not to signal if `.teach/signal.js` is missing.
- Running `/teach` in the fresh clone detects that `.teach/` is absent and runs setup.
