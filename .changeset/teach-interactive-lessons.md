---
"mattpocock-skills": minor
---

Add interactive lessons to `teach`. A learner can opt in once per workspace, and every `/teach` then starts a small local server (Node 18 or later, built-ins only) that serves the lessons and adds an "ask the teacher" panel to each page. From the page they can ask a question, request a change to the lesson, or ask for the next one; the agent's reply appears in the panel, and the agent can tell the open page that a new next lesson exists or that the current lesson changed, without losing the learner's place, quiz answers or chat.

- Three tiers: interactive; served with chat not connected (a reason, a fix and a Retry button); and plain lesson files exactly as before. Declining, or having no Node, leaves plain files, and `/teach interactive` resets and tries again. The lesson file on disk is identical in every tier.
- Works with Claude Code, Antigravity, pi and Pithagoras through small adapter programs that drive the learner's own CLI, and can offer to write a connector for an unrecognised harness. The skill finds the harness's CLI on PATH or in its known install folders, shows install or login steps for the learner's OS in chat, and never runs an installer or handles credentials.
- The learner is told, before the first message each session, what the agent may do: read and edit files in the workspace, browse for research where the harness allows it, and run only the signalling command (for pi and Pithagoras, which cannot be narrowed, the notice says so). The server listens on this computer only unless the learner picks a private network address (Pithagoras, which is driven from elsewhere, is always served on the network), and every message needs a per-session token carried in the URL fragment.
- The teacher never states a quiz answer, whether writing a lesson, revising one, or replying in the panel; the rule is in `SKILL.md`, the quiz format guide and the workspace's teaching-signals block, which the panel's agent reads.
- A used-up usage allowance is reported as a clear "usage limit reached" message rather than a generic failure.
- Lessons carry a stable next-lesson hook and a follow-up reminder that is true in every tier. The `teach` docs page now covers interactive mode. `teach` stays user-invoked only.
