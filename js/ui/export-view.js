import { db } from '../storage.js';
import { buildEpub, downloadBlob } from '../epub.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function renderExportView(container, { projectId }) {
  container.innerHTML = `
    <section class="panel">
      <h2>4. Review &amp; export</h2>
      <div id="chapters-review"></div>
      <button id="export-epub" class="btn-primary">Export .epub</button>
    </section>
  `;

  const reviewEl = container.querySelector('#chapters-review');

  async function renderReview() {
    const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
    reviewEl.innerHTML = chapters.map((c) => `
      <details class="chapter-review" data-id="${c.id}">
        <summary>${c.index + 1}. ${escapeHtml(c.title)} <span class="status-${c.status}">(${c.status})</span></summary>
        <div class="side-by-side">
          <div><h4>Source</h4><textarea readonly rows="10">${escapeHtml(c.text)}</textarea></div>
          <div><h4>Translation</h4><textarea class="translated-text" rows="10">${escapeHtml(c.translatedText || '')}</textarea></div>
        </div>
      </details>
    `).join('');

    // 'needs-manual-split'/'failed' are review flags worth keeping visible -
    // only auto-promote from the "nothing done yet" states, so a quick typo
    // fix doesn't silently erase the signal that a chapter needed attention.
    const AUTO_PROMOTE_FROM = new Set(['untranslated', 'failed', 'translated']);
    reviewEl.querySelectorAll('.translated-text').forEach((ta) => {
      ta.addEventListener('blur', async () => {
        const id = ta.closest('.chapter-review').dataset.id;
        const chapter = chapters.find((c) => c.id === id);
        chapter.translatedText = ta.value;
        if (ta.value.trim() && AUTO_PROMOTE_FROM.has(chapter.status)) {
          chapter.status = 'translated';
        }
        await db.put('chapters', chapter);
      });
    });
  }

  container.querySelector('#export-epub').addEventListener('click', async () => {
    const project = await db.get('projects', projectId);
    const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
    const blob = await buildEpub({ title: project.title, author: project.author, chapters });
    downloadBlob(blob, `${project.title.replace(/[^\w\-]+/g, '_')}.epub`);
  });

  renderReview();
}
