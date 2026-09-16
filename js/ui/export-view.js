import { db } from '../storage.js';
import { buildEpub, downloadBlob } from '../epub.js';

export function renderExportView(container, { projectId }) {
  container.innerHTML = `
    <section class="panel">
      <h2>4. Review &amp; export</h2>
      <div id="chapters-review"></div>
      <button id="export-epub">Export .epub</button>
    </section>
  `;

  const reviewEl = container.querySelector('#chapters-review');

  async function renderReview() {
    const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
    reviewEl.innerHTML = chapters.map((c) => `
      <details class="chapter-review" data-id="${c.id}">
        <summary>${c.index + 1}. ${c.title} <span class="status-${c.status}">(${c.status})</span></summary>
        <div class="side-by-side">
          <div><h4>Source</h4><textarea readonly rows="10">${c.text}</textarea></div>
          <div><h4>Translation</h4><textarea class="translated-text" rows="10">${c.translatedText || ''}</textarea></div>
        </div>
      </details>
    `).join('');

    reviewEl.querySelectorAll('.translated-text').forEach((ta) => {
      ta.addEventListener('blur', async () => {
        const id = ta.closest('.chapter-review').dataset.id;
        const chapter = chapters.find((c) => c.id === id);
        chapter.translatedText = ta.value;
        chapter.status = ta.value.trim() ? 'translated' : chapter.status;
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
