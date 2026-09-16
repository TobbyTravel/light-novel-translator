import { splitIntoChapters, splitByLineCount } from '../splitter.js';
import { db, newId } from '../storage.js';

export function renderImportView(container, { onProjectReady }) {
  container.innerHTML = `
    <section class="panel">
      <h2>1. Import source text</h2>
      <label>Project title <input type="text" id="proj-title" placeholder="My Light Novel" /></label>
      <label>Author <input type="text" id="proj-author" placeholder="(optional)" /></label>
      <label>Raw .txt file <input type="file" id="proj-file" accept=".txt" /></label>
      <div id="chapter-preview"></div>
      <button id="commit-import" disabled>Create project from these chapters</button>
    </section>
  `;

  const fileInput = container.querySelector('#proj-file');
  const preview = container.querySelector('#chapter-preview');
  const commitBtn = container.querySelector('#commit-import');
  let detectedChapters = [];
  let rawText = '';

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    rawText = await file.text();
    detectedChapters = splitIntoChapters(rawText);
    renderPreview();
  });

  function renderPreview() {
    preview.innerHTML = `
      <p>${detectedChapters.length} chapter(s) detected. Adjust below if boundaries look wrong, then commit.</p>
      <button id="use-fixed-split" type="button">Use fixed-size chunks instead</button>
      <ul class="chapter-list">
        ${detectedChapters.map((c, i) => `
          <li>
            <input type="text" data-idx="${i}" class="chapter-title-input" value="${escapeAttr(c.title)}" />
            <span class="muted">${c.text.length} chars</span>
          </li>`).join('')}
      </ul>
    `;
    commitBtn.disabled = detectedChapters.length === 0;

    preview.querySelector('#use-fixed-split').addEventListener('click', () => {
      detectedChapters = splitByLineCount(rawText, 300);
      renderPreview();
    });

    preview.querySelectorAll('.chapter-title-input').forEach((input) => {
      input.addEventListener('input', () => {
        detectedChapters[Number(input.dataset.idx)].title = input.value;
      });
    });
  }

  commitBtn.addEventListener('click', async () => {
    const title = container.querySelector('#proj-title').value.trim() || 'Untitled Novel';
    const author = container.querySelector('#proj-author').value.trim();
    const projectId = newId();
    await db.put('projects', { id: projectId, title, author, createdAt: new Date().toISOString() });
    for (const [i, ch] of detectedChapters.entries()) {
      await db.put('chapters', {
        id: newId(),
        projectId,
        index: i,
        title: ch.title,
        text: ch.text,
        translatedText: '',
        status: 'untranslated',
      });
    }
    onProjectReady(projectId);
  });
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}
