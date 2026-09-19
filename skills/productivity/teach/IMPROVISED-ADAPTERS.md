# Improvised Adapters

Reference guide for `/teach` when running inside an unrecognised agent harness (`other`).

## Overview

The `teach` skill includes shipped adapters for `claude-code`, `antigravity`, and `pi` (which also serves `pithagoras`). When running inside an unrecognised harness, the skill can offer to improvise a custom connector so the learner can use interactive chat from their browser lessons.

The agent improvises **only the adapter**. The shipped server continues to handle token generation, HTTP and SSE serving, port binding, lesson rendering, widget injection, and the interactive lease.

## Pre-conditions: When to Offer a Connector

1. **Documented non-interactive route required:**
   The agent may offer to write an adapter **only** if it can identify a documented, non-interactive way to reach its own engine (such as a CLI command that takes prompt arguments and returns a response, or a local/remote HTTP webhook/API).
   - If **no documented non-interactive route exists**: The agent must state this plainly to the learner in one line:
     > "I don't have a documented non-interactive way to reach myself in this harness, so live chat is unavailable."
     The session proceeds in **tier 2** (served static lessons with quiz persistence, no chat widget).

2. **One-line question to the learner:**
   If a documented non-interactive route does exist, the agent asks the learner in exactly one line:
   > "I don't recognise this harness, but I can try writing a custom connector to enable live chat. Would you like me to try?"

3. **Refusal:**
   If the learner says no (or declines):
   - Record the refusal in `.teach/config.json`:
     ```json
     {
       "version": 1,
       "outcome": {
         "status": "declined",
         "date": "2026-09-19T19:00:00.000Z"
       }
     }
     ```
   - Do **not** write any adapter.
   - The session proceeds in tier 2.
   - On future starts in this workspace, the skill checks `status === 'declined'` and remains silent.

## Workspace Isolation

- **Workspace-local only:** The improvised adapter must be written into `.teach/adapters/<harness-slug>.js` (or `.teach/adapters/connector.js`) inside the workspace root.
- **Skill folder is immutable:** Nothing in the skill folder (`bridge/`, `adapters/`, etc.) may be created or edited.
- Because `.teach/` contains a `.gitignore` ignoring `*`, workspace-local adapters and configuration are never committed to version control.

## The Adapter Contract

The improvised adapter is an independent program executed as a child process. It must satisfy the standard adapter contract:
- Communicates via newline-delimited JSON over standard I/O (stdin/stdout).
- Receives one request object on stdin, writes one result object to stdout, and exits.
- Operations:
  1. `check`: Tests binary presence and authentication status without spending a model turn.
     - Request: `{"op": "check"}`
     - Success: `{"type": "result", "ok": true, "permissions": "<plain-text description of permissions really granted>"}`
     - Failure: `{"type": "result", "ok": false, "error": {"code": "<code>", "message": "<msg>", "hint": "<hint>"}}`
  2. `prime`: The read-only initialization turn.
     - Request: `{"op": "prime", "lesson": "<path>", "instruction": "<read-only instruction>"}`
     - Must NOT modify, write, or delete any workspace files (the server validates this via a SHA-256 workspace hash before and after).
     - Returns an opaque session identity: `{"type": "result", "ok": true, "session": "<opaque-id>"}`
  3. `send`: A conversation turn with the learner.
     - Request: `{"op": "send", "session": "<opaque-id>", "lesson": "<path>", "text": "[sent from ...]\n<user text>"}`
     - Returns the model's text: `{"type": "result", "ok": true, "text": "<reply>"}`
- Closed set of error codes: `missing`, `not-logged-in`, `unreachable`, `unauthorised`, `timeout`, `failed`.
- Execution safety:
  - Engine arguments must be passed as an array to `child_process.spawn` with `shell: false`. Never construct shell command strings.
  - Error messages and hints must be fixed strings; never echo raw CLI stdout/stderr or leak account credentials/emails.

## Running the Improvised Adapter

When starting the server, pass the improvised adapter command and mark it as improvised:

```bash
node <skill-path>/bridge/serve.js --workspace <workspace> --bind <mode> --adapter '["node", ".teach/adapters/connector.js"]' --improvised true
```

The `--improvised true` argument marks the connector in the handshake state:
`{ state: 'interactive', permissions: '...', improvised: true }`.

## Unreviewed Connector Notice

In the browser lesson page, the widget displays the adapter's permission notice. Because the connector was improvised by an AI, the server's fixed unreviewed-connector warning is displayed directly above the permissions text:

> **This connector was written by an AI for this workspace and has not been reviewed. Check what it does before you rely on it.**
>
> Before you start: The agent session will have the following permissions: ...

The learner must click "I understand" before the chat composer is enabled.

## Reuse and Failing Kept Adapters

1. **Reuse:** On subsequent sessions in the workspace, the skill checks for an existing kept adapter in `.teach/adapters/` and reuses it directly without asking or re-generating.
2. **Failing `check` on a kept adapter:**
   - If the engine binary is removed, or authentication lapses, the handshake `check` will fail.
   - The handshake transitions to `static` (tier 2) and presents the error reason and hint in the widget pill (with a Retry button).
   - **Crucial:** The skill must **never silently rewrite** a failing kept adapter.
   - To re-create or repair the connector, the learner explicitly runs `/teach interactive`.
