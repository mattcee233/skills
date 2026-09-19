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

## Starting a Session

Every `/teach` in a workspace set up for interactive mode starts a fresh server and replies with a link to the current lesson. `<skill>` below is the folder that holds this file; resolve it again on every invocation and never reuse an earlier path. Run every command from the workspace root. Each command is a small program you run; you do the asking and the replying.

1. **Read the notice.** Run `node <skill>/bridge/session.js notice --workspace .`. It prints `{silent, notice, canStart}`.
   - `canStart: false` (`declined` or `no-node`): say `notice` if it is not silent, write plain files, and stop here. After `declined` say nothing.
   - `canStart: true` with a `notice` (`login-failed`): carry on. The start reply already opens with that line, so do not say it twice.
2. **Name the harness you are running inside**, meaning the application and not your model, as one of `claude-code`, `antigravity`, `pi`, `pithagoras` or `other`, with a one-line reason naming your evidence. Say `other` when unsure. `pithagoras` means you are running inside a Pithagoras instance: your skills and docs live under its install folder (`/opt/pithagoras`, say) and the learner talks to you from a channel such as Telegram or its web portal. `pi` means you are the plain pi coding agent, in a terminal or its own interface, beside the learner. Both run the pi agent, so the difference is where the learner is, not which agent you are. Run `node <skill>/bridge/session.js detect --harness <id> --reason "<evidence>"`.
   - `resolved: true`: tell the learner the `assumption` line, in one line, then carry on.
   - `conflict: true` or `inconclusive: true` (your answer disagrees with the environment, or you said `other`): ask the `question` and use the learner's answer as the harness id. Never guess.
3. **Find out which address to bind.** Run `node <skill>/bridge/session.js bind --harness <id>`.
   - A `question` is present: ask it. A desktop harness defaults to this computer only. An unrecognised harness has no default. A remote harness (Pithagoras) is never offered this computer only, and with several private addresses the question asks which one.
   - No `question`: use the `bind` it printed and do not ask.
   - The answer becomes `--mode loopback` or `--mode network`, plus `--address <ip>` when the learner chose one.
4. **Start the server.** Run one command in the background so it outlives your shell command:
   `node <skill>/bridge/session.js start --workspace . --harness <id> --mode <mode> [--address <ip>]`
   - It stops any leftover server from an earlier invocation, picks a random port, starts the server, waits up to 45 seconds for the connection verdict, records the outcome, prints one JSON line and then keeps serving until stopped. Nothing about the port or address is stored.
   - Background it with your harness's own background-task tool if you have one. Otherwise on macOS or Linux use `nohup node ... > .teach/start.log 2>&1 &` (on Pithagoras use `setsid nohup`), and on Windows use `Start-Process -WindowStyle Hidden -RedirectStandardOutput .teach\start.log node ...`. Read the one JSON line from that output, allowing about a minute, then delete the log: it holds the token.
5. **Reply with the result.**
   - `needs: "bind"`: nothing was started. Ask the `question` and run step 4 again with the answer.
   - Otherwise reply with `reply` exactly: the link on its own line, then the verdict in the same message. The verdict is `chat is ready`, a one-line reason and fix, or `still connecting`. Give the link to the learner only, since its fragment is the token. Do not poll again unless asked. For "check again" run `node .teach/signal.js retry`, and `node .teach/signal.js status` to read the state.
6. **The outcome is recorded for you** by the command: `ok`, or `login-failed` with the hint. Other failures (`missing`, `unreachable`, a conformance failure, a prime timeout) are not recorded, because the next start checks again.
7. **An unrecognised harness (`other`)**: follow [IMPROVISED-ADAPTERS.md](./IMPROVISED-ADAPTERS.md). If a connector is kept or written, add `--adapter '<json array>' --improvised true` to step 4. With no connector, start without `--adapter` and the learner gets served static pages.

## Re-trying and `/teach interactive`

- `/teach interactive` is a reserved first word.
- Alternatively, a plain request such as "try interactive mode again" or "check again".
- Resets any previously recorded outcome (`declined`, `no-node`, `login-failed`).
- Re-runs setup steps (Node check, refreshing launcher and `AGENTS.md` block) without repeating the mission interview.

## Fresh Clones

- `.teach/` is machine-local and not committed.
- In a fresh clone without `.teach/`, the committed `AGENTS.md` block instructs the agent not to signal if `.teach/signal.js` is missing.
- Running `/teach` in the fresh clone detects that `.teach/` is absent and runs setup.
