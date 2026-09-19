# Quiz Markup Hook Format

`QUIZ-FORMAT.md` defines the minimal markup hook that quiz components in lessons follow. The injected page script (`widget.js`) reads this hook to manage interactive checking, feedback, and answer persistence across page reloads and lesson revisions.

## Minimal Hook Structure

A quiz question requires only standard HTML elements with a few data attributes:

```html
<div class="quiz-q" data-quiz-question="q1">
  <p>In <code>git log --graph</code>, what does a <code>*</code> mark?</p>
  <ul>
    <li><label><input type="radio" name="q1" value="a"> A merge conflict marker.</label></li>
    <li><label><input type="radio" name="q1" value="b" data-correct> A commit on some branch.</label></li>
    <li><label><input type="radio" name="q1" value="c"> A stashed change entry.</label></li>
  </ul>
  <button type="button" data-quiz-check>Check</button>
  <p class="fb" data-quiz-feedback></p>
</div>
```

## Never Reveal Answers

Mark the correct choice only with the attributes below. Never state, hint at or confirm an answer in the lesson text, in a chat reply, in the summary of a revision ("the answer is still X"), or when writing another lesson. If a revision changes a question or its options, say only that it changed. Feedback appears after the learner presses Check.

## Hook Specification

### 1. Question Container (`[data-quiz-question]` or `.quiz-q`)
- **Selector:** `[data-quiz-question]` or `.quiz-q`.
- **Identity:** Set a stable identifier via `data-quiz-question="<id>"` (e.g. `q1`, `commit-marker`). If omitted, the script falls back to `data-i`, the radio group `name`, or the question's DOM index. Using an explicit id ensures the learner's answer is preserved even when surrounding lesson text or questions are revised.
- **Correct answer (container-level alternative):** `data-correct="<value>"` (e.g. `data-correct="b"`).

### 2. Options (`input[type="radio"]`)
- Grouped with a matching `name` attribute.
- Each choice carries a distinct `value`.
- **Correct answer:** Mark the correct choice with the `data-correct` attribute (e.g. `<input type="radio" value="b" data-correct>`), unless specified on the container via `data-correct="<value>"`.
- **Custom feedback (optional):** Add `data-feedback="<text>"` on an option to override default feedback text when selected.

### 3. Check Button (`[data-quiz-check]` or `[data-check]`)
- **Selector:** `[data-quiz-check]`, `[data-check]`, or a `<button>` inside the question container.
- Clicking the button evaluates the current selection, renders feedback, and saves the checked state to `localStorage`.
- If clicked with no option selected, prompts the learner with "Pick an answer first."

### 4. Feedback Display (`[data-quiz-feedback]` or `.fb`)
- **Selector:** `[data-quiz-feedback]` or `.fb` inside the question container.
- If omitted from the HTML, the script automatically creates and places one after the check button.
- Displays feedback text:
  - **Correct:** "Correct." (or custom text), receiving the `.ok` class.
  - **Incorrect:** "Not quite: have another look." (or custom text), receiving the `.no` class.
  - **Unselected:** "Pick an answer first."
- Changing the selected radio option clears previous feedback until "Check" is pressed again.

## Persistence Rules

- **Per-lesson isolation:** Saved answers are keyed by lesson path (`teach.quiz:<pathname>`). Lessons never share state.
- **Data shape:** Stored as `{ [questionId]: { selected: '<value>', checked: true|false } }`.
- **Reloads & lesson revisions:** Restores radio selection and shown feedback on initial page load and on in-place lesson updates (`teach:lesson-updated` from a `reload` signal).
- **Graceful degradation:** A lesson with no quiz, or a quiz that does not follow the hook, runs cleanly with no errors.
