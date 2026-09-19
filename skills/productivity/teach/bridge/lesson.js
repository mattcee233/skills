'use strict';
// Lesson-authoring utilities, hooks and template for /teach lessons.
// Every lesson carries the stable next-lesson hook and the quiz hook on disk,
// with the follow-up reminder worded to be true in every tier, opening cleanly
// as a plain file without depending on the interactive server.

const REMINDER_TEXT = 'Ask in the chat panel if you see one, or ask me in this conversation.';
const NEXT_LESSON_ATTR = 'data-teach-next';

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNextLessonHook(lessonHref, lessonTitle) {
  const href = escapeHtml(lessonHref);
  const title = escapeHtml(lessonTitle);
  return `<a href="${href}" class="teach-next" data-teach-next>Next lesson: ${title}</a>`;
}

function renderQuiz(quiz) {
  if (!quiz) return '';
  const id = escapeHtml(quiz.id || 'q1');
  const question = escapeHtml(quiz.question || '');
  const options = (quiz.options || []).map((opt, i) => {
    const val = escapeHtml(opt.value || String(i));
    const label = escapeHtml(opt.label || opt.text || '');
    const correctAttr = opt.correct ? ' data-correct' : '';
    const feedbackAttr = opt.feedback ? ` data-feedback="${escapeHtml(opt.feedback)}"` : '';
    return `      <li><label><input type="radio" name="${id}" value="${val}"${correctAttr}${feedbackAttr}> ${label}</label></li>`;
  }).join('\n');

  return `    <section class="quiz">
      <h2>Check your understanding</h2>
      <div class="quiz-q" data-quiz-question="${id}">
        <p>${question}</p>
        <ul>
${options}
        </ul>
        <button type="button" data-quiz-check>Check</button>
        <p class="fb" data-quiz-feedback></p>
      </div>
    </section>`;
}

function renderCitations(citations) {
  if (!citations || citations.length === 0) return '';
  const items = citations.map(c => {
    const url = typeof c === 'string' ? c : c.url;
    const text = typeof c === 'string' ? c : (c.title || c.url);
    return `      <li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a></li>`;
  }).join('\n');

  return `    <section class="citations">
      <h2>Primary sources &amp; citations</h2>
      <ul>
${items}
      </ul>
    </section>`;
}

function renderLesson({
  title,
  number,
  slug,
  explanation = '',
  citations = [],
  quiz = null,
  nextLesson = null,
  assetsPath = '../assets/style.css',
} = {}) {
  const safeTitle = escapeHtml(title || 'Lesson');
  const quizHtml = renderQuiz(quiz);
  const citationsHtml = renderCitations(citations);
  const nextLessonHtml = nextLesson && nextLesson.href && nextLesson.title
    ? `    <nav class="lesson-nav">\n      ${formatNextLessonHook(nextLesson.href, nextLesson.title)}\n    </nav>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="${escapeHtml(assetsPath)}">
</head>
<body>
  <header>
    <h1>${safeTitle}</h1>
  </header>

  <main>
    <article class="lesson-content">
      ${explanation}
    </article>

${quizHtml}

${citationsHtml}

${nextLessonHtml}

    <footer class="lesson-footer">
      <p class="lesson-reminder">${REMINDER_TEXT}</p>
    </footer>
  </main>
</body>
</html>
`;
}

function upsertNextLessonButton(html, nextLessonHref, nextLessonTitle) {
  const hook = formatNextLessonHook(nextLessonHref, nextLessonTitle);
  const nextRegex = /<a\s+[^>]*data-teach-next[^>]*>.*?<\/a>/is;

  if (nextRegex.test(html)) {
    return html.replace(nextRegex, hook);
  }

  // Insert before </main> or </body>
  if (html.includes('</main>')) {
    return html.replace('</main>', `  <nav class="lesson-nav">\n    ${hook}\n  </nav>\n</main>`);
  }

  if (html.includes('</body>')) {
    return html.replace('</body>', `  <nav class="lesson-nav">\n    ${hook}\n  </nav>\n</body>`);
  }

  return html + '\n' + hook;
}

module.exports = {
  REMINDER_TEXT,
  NEXT_LESSON_ATTR,
  escapeHtml,
  formatNextLessonHook,
  renderLesson,
  upsertNextLessonButton,
};
