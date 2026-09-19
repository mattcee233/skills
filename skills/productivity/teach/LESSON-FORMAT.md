# LESSON-FORMAT.md — Lesson Authoring and Hook Format

A **lesson** is the primary unit in which knowledge and skills reach the learner in `/teach`. Every lesson is a self-contained HTML file, saved to `./lessons/` and titled `0001-<dash-case-name>.html` where the number increments sequentially.

Every lesson is authored so that it works seamlessly with the interactive page in any tier without depending on it. It opens cleanly as a plain file directly from disk, with no server or runtime dependencies required.

---

## Complete Lesson Template

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Understanding Loops</title>
  <link rel="stylesheet" href="../assets/style.css">
</head>
<body>
  <header>
    <h1>Understanding Loops</h1>
  </header>

  <main>
    <article class="lesson-content">
      <p>A loop repeats a sequence of instructions until a specific condition is met.</p>
      <!-- Lesson explanation and concepts here -->
    </article>

    <section class="quiz">
      <h2>Check your understanding</h2>
      <div class="quiz-q" data-quiz-question="q1">
        <p>Which keyword immediately terminates the enclosing loop?</p>
        <ul>
          <li><label><input type="radio" name="q1" value="a"> continue</label></li>
          <li><label><input type="radio" name="q1" value="b" data-correct> break</label></li>
          <li><label><input type="radio" name="q1" value="c"> return</label></li>
        </ul>
        <button type="button" data-quiz-check>Check</button>
        <p class="fb" data-quiz-feedback></p>
      </div>
    </section>

    <section class="citations">
      <h2>Primary sources &amp; citations</h2>
      <ul>
        <li><a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Loops_and_iteration" target="_blank" rel="noopener noreferrer">MDN: Loops and iteration</a></li>
      </ul>
    </section>

    <nav class="lesson-nav">
      <!-- Stable next-lesson hook: present on disk so lessons opened later already have it -->
      <a href="0002-nested-loops.html" class="teach-next" data-teach-next>Next lesson: Nested Loops</a>
    </nav>

    <footer class="lesson-footer">
      <!-- Follow-up reminder: worded to be true in every tier -->
      <p class="lesson-reminder">Ask in the chat panel if you see one, or ask me in this conversation.</p>
    </footer>
  </main>
</body>
</html>
```

---

## Required Hooks and Elements

### 1. Stable Next-Lesson Hook (`[data-teach-next]`)

Each lesson gets the stable next-lesson hook and button directly on disk:

```html
<a href="0002-<name>.html" class="teach-next" data-teach-next>Next lesson: <Title></a>
```

- **Attribute**: `data-teach-next`.
- **Class**: `teach-next` (default styling in `widget.css` or shared stylesheet).
- **On disk**: When the agent writes the next lesson, it adds or updates this hook in the current lesson file on disk. That way, a learner reopening the lesson later as a plain file already has the next-lesson button.
- **In interactive mode**: When a `next-lesson` signal fires, the injected page script upserts `[data-teach-next]` in place, updates its `href` and text to `"Next lesson: <Title>"`, pulses it, and shows a toast.

### 2. Follow-Up Reminder Wording

Every lesson must include the exact reminder wording:

> **"Ask in the chat panel if you see one, or ask me in this conversation."**

This wording is carefully chosen to be true in every tier:
- In **interactive mode (Tier 1)** with live chat connected, the learner sees the chat panel and can ask there.
- In **static / chat-not-connected (Tier 2)** or **plain files mode (Tier 3)** without a chat panel, the learner asks the agent in the main conversation window.
- It never makes false promises about an interactive chat panel being present.

### 3. Quiz Markup Hook

Quizzes must strictly follow the minimal declarative markup convention documented in [QUIZ-FORMAT.md](./QUIZ-FORMAT.md):
- Container: `[data-quiz-question="<id>"]` or `.quiz-q`.
- Correct option: marked with `data-correct` on the `<input type="radio">`.
- Check button: `[data-quiz-check]` or `<button type="button" data-quiz-check>Check</button>`.
- Feedback container: `[data-quiz-feedback]` or `<p class="fb" data-quiz-feedback></p>`.
- Free-text question: a `.quiz-q` with `data-quiz-type="freetext"` holding a `<textarea>` instead of radio options, the usual button and feedback line, and a model answer in a hidden `[data-quiz-answer]` element. Example: `<div class="quiz-q" data-quiz-question="f1" data-quiz-type="freetext"><p>Explain it in your own words.</p><textarea name="f1"></textarea><button type="button" data-quiz-check>Show model answer</button><p class="fb" data-quiz-feedback></p><div data-quiz-answer hidden>...</div></div>`. With chat live the button sends the learner's words to the teacher to grade instead of revealing the model answer; see [QUIZ-FORMAT.md](./QUIZ-FORMAT.md#free-text-questions).

The injected script reads these declarative attributes to handle feedback and save answers in `localStorage`. The lesson requires no custom `<script>` tags, ensuring that in-place updates via `reload` work cleanly.

---

## Agent Rules and Signalling Behaviour

### Rule 1: Update Lessons In Place

Always update the existing lesson file on disk directly. **Never tag with revisions**: never tag files with revision numbers or suffixes (such as `0001-loops-v2.html` or `0001-loops-revised.html`). The lesson path `lessons/0001-loops.html` remains stable.

### Rule 2: Write the File First, Signal Second

**Always write or update the lesson file on disk first, and signal only after the file is completely written.**

The disk is the single source of truth. Connected lesson pages are served directly from disk with `Cache-Control: no-store`. A signal is only a nudge to an open page that disk contents have changed. If you signal before the file is written, the page will fetch old or half-written content.

### Rule 3: The Two Signalling Events

Signal using the workspace launcher (`node .teach/signal.js <event> ...`) or the file-drop fallback in `.teach/signals/*.json`:

1. **`reload`** — Used when you change or revise the current lesson that the learner may be reading:
   - **Launcher command**: `node .teach/signal.js reload lessons/<file>.html`
   - **File fallback**: `{"event": "reload", "lesson": "lessons/<file>.html"}`
   - **Effect**: The open page swaps the lesson content in place, keeping the chat thread, pending spinner, scroll position, and stored quiz answers.

2. **`next-lesson`** — Used when you create the next lesson for the learner to move on to:
   - **First**: Add or update the next-lesson hook in the current lesson on disk:
     `<a href="<next-file>.html" class="teach-next" data-teach-next>Next lesson: <Title></a>`
   - **Second**: Write the new lesson file to `./lessons/<next-file>.html`.
   - **Third**: Signal with the launcher:
     `node .teach/signal.js next-lesson lessons/<next-file>.html "<lesson title>"`
   - **File fallback**: `{"event": "next-lesson", "lesson": "lessons/<next-file>.html", "title": "<lesson title>"}`
   - **Effect**: The open page updates the next-lesson button with a pulse and toast, without moving or scrolling the learner.

### Rule 4: If `.teach/signal.js` is Missing, Do Not Signal

If the launcher `.teach/signal.js` is missing (for example, in a fresh workspace before setup or in a repository cloned without `.teach/`), **do not attempt to signal**. Write the lesson file to disk as usual and inform the learner that they can run `/teach interactive` to enable interactive mode.
