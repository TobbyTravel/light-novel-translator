import { db } from '../storage.js';
import { runTranslation, retranslateChapter, planTranslationBatches } from '../translation.js';
import { translationSystemPrompt, translationUserPrompt } from '../prompts.js';
import { estimateCallTokens, formatTokenCount } from '../tokens.js';
import { loadBibleAsPlainObject } from '../extraction.js';
import { joinChaptersWithMarkers } from '../grouping.js';
import { renderRefusalPanel } from './refusal-panel.js';

export function renderTranslateView(container, { projectId, settings }) {
  container.innerHTML = `
    <section class="panel">
      <h2>3. Translate</h2>
      <div class="row">
        <button id="run-translation">Translate all chapters</button>
        <span id="translation-status" class="muted"></span>
      </div>
      <div id="chapter-status-list"></div>
      <div id="refusal-panel-translation"></div>
    </section>
  `;

  const statusEl = container.querySelector('#translation-status');
  const listEl = container.querySelector('#chapter-status-list');

  async function renderList() {
    const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
    const bible = await loadBibleAsPlainObject(projectId);
    const batches = planTranslationBatches(chapters, bible, settings);
    let total = 0;
    const rows = batches.flatMap((batch, bIdx) => {
      const grouped = batch.length > 1;
      const system = translationSystemPrompt({ sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage, grouped });
      const text = joinChaptersWithMarkers(batch);
      const estimated = estimateCallTokens({ system, prompt: translationUserPrompt({ bible, chapterTitle: batch[0].title, chapterText: text }) });
      const actual = batch[0].promptTokens;
      const used = actual ?? estimated;
      total += used;
      const overBudget = used > settings.contextBudget;
      const stripe = bIdx % 2 === 0 ? 'batch-stripe-a' : 'batch-stripe-b';
      return batch.map((c, i) => `
        <tr class="${stripe} ${overBudget ? 'over-budget' : ''}" data-id="${c.id}">
          <td>${c.index + 1}</td>
          <td>${c.title}${grouped ? ` <span class="muted">(batch of ${batch.length})</span>` : ''}</td>
          <td class="status-${c.status}">${c.status}</td>
          <td>${i === 0 ? (actual != null ? `${formatTokenCount(actual)} actual` : `~${formatTokenCount(estimated)} est.`) : '<span class="muted">shares batch above</span>'}${overBudget && i === 0 ? ' ⚠' : ''}</td>
          <td><button class="retranslate-btn" data-id="${c.id}">Retranslate</button></td>
        </tr>`);
    }).join('');
    listEl.innerHTML = `
      <p class="muted">${batches.length} call(s) for ${chapters.length} chapter(s) - total ~${formatTokenCount(total)} tokens against a ${formatTokenCount(settings.contextBudget)} context budget.</p>
      <table class="bible-table">
        <thead><tr><th>#</th><th>Title</th><th>Status</th><th>Tokens</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    listEl.querySelectorAll('.retranslate-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!settings.model) return alert('Set an Ollama model name in Settings first.');
        btn.disabled = true;
        btn.textContent = 'Working...';
        const chapter = chapters.find((c) => c.id === btn.dataset.id);
        await retranslateChapter({ projectId, chapter, settings });
        await renderList();
      });
    });
  }

  container.querySelector('#run-translation').addEventListener('click', async () => {
    if (!settings.model) return alert('Set an Ollama model name in Settings first.');
    const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
    statusEl.textContent = 'Running...';
    let failed = 0;
    await runTranslation({
      projectId,
      chapters,
      settings,
      onProgress: ({ index, total, batch, done, estimatedTokens }) => {
        const batchLabel = batch && batch.length > 1 ? `${batch.length} chapters (${batch[0].title} .. ${batch[batch.length - 1].title})` : batch?.[0]?.title;
        statusEl.textContent = done
          ? `Done (${failed} chapter(s) failed)`
          : `Batch ${index + 1}/${total}: ${batchLabel} (~${formatTokenCount(estimatedTokens)} tokens est.)`;
      },
      onChapterError: ({ chapter, error }) => {
        failed++;
        console.error(`Translation failed for "${chapter.title}"`, error);
      },
    });
    await renderList();
  });

  renderList();
  renderRefusalPanel(container.querySelector('#refusal-panel-translation'), { projectId, settings, kind: 'translation' });
}
