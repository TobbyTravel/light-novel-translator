import { db } from '../storage.js';
import { runTranslation, retranslateChapter, planTranslationBatches } from '../translation.js';
import { translationSystemPrompt, translationUserPrompt } from '../prompts.js';
import { estimateCallTokens, formatTokenCount } from '../tokens.js';
import { loadBibleAsPlainObject } from '../extraction.js';
import { joinChaptersWithMarkers } from '../grouping.js';
import { renderRefusalPanel } from './refusal-panel.js';
import { createEtaTracker } from '../eta.js';
import { activityStart, activitySetStatus, activityPushToken, activityFinish } from './activity.js';
import { getJob } from '../jobs.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function renderTranslateView(container, { projectId, settings }) {
  container.innerHTML = `
    <section class="panel">
      <h2>3. Translate</h2>
      <div class="row">
        <button id="run-translation" class="btn-primary">Translate all chapters</button>
        <button id="resume-translation" hidden>Resume interrupted run</button>
        <button id="stop-translation" hidden>Stop</button>
      </div>
      <div id="chapter-status-list"></div>
      <div id="refusal-panel-translation"></div>
    </section>
  `;

  const listEl = container.querySelector('#chapter-status-list');
  const resumeBtn = container.querySelector('#resume-translation');

  async function checkResumable() {
    const job = await getJob(projectId);
    resumeBtn.hidden = !(job && job.kind === 'translation' && job.status === 'interrupted');
    return job;
  }

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
          <td>${escapeHtml(c.title)}${grouped ? ` <span class="muted">(batch of ${batch.length})</span>` : ''}</td>
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

  const runBtn = container.querySelector('#run-translation');
  const stopBtn = container.querySelector('#stop-translation');

  async function startRun(startBatchIndex = 0) {
    const existingJob = await getJob(projectId);
    if (existingJob?.status === 'running') {
      return alert(`A ${existingJob.kind} job is already running for this project - wait for it to finish or stop it first.`);
    }
    if (!settings.model) return alert('Set an Ollama model name in Settings first.');
    runBtn.disabled = true;
    resumeBtn.disabled = true;
    stopBtn.hidden = false;
    const controller = new AbortController();
    stopBtn.onclick = () => {
      stopBtn.disabled = true;
      controller.abort();
    };
    const originalTitle = document.title;
    const eta = createEtaTracker();
    const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
    activityStart();
    let failed = 0;
    await runTranslation({
      projectId,
      chapters,
      settings,
      startBatchIndex,
      signal: controller.signal,
      onToken: (chunk, full) => activityPushToken(chunk, full),
      onProgress: ({ index, total, batch, done, estimatedTokens, aborted }) => {
        const batchLabel = batch && batch.length > 1 ? `${batch.length} chapters (${batch[0].title} .. ${batch[batch.length - 1].title})` : batch?.[0]?.title;
        if (done) {
          activitySetStatus(aborted
            ? `Stopped by request (${index}/${total} batches done, ${failed} failed).`
            : `Done (${failed} chapter(s) failed)`);
          activityFinish();
          document.title = originalTitle;
          return;
        }
        const remaining = eta.estimate(index, total - index);
        activitySetStatus(`Batch ${index + 1}/${total}: ${batchLabel} (~${formatTokenCount(estimatedTokens)} tokens est.)${remaining ? ` - ${remaining}` : ''}`);
        document.title = `[${index + 1}/${total}] ${originalTitle}`;
      },
      onChapterError: ({ chapter, error }) => {
        failed++;
        console.error(`Translation failed for "${chapter.title}"`, error);
      },
    });
    runBtn.disabled = false;
    resumeBtn.disabled = false;
    stopBtn.hidden = true;
    stopBtn.disabled = false;
    await renderList();
    await checkResumable();
    // Chapters get flagged as each call completes (js/translation.js), not
    // only via a manual "Run crosscheck" click - refresh the panel so a
    // flag from this run is visible immediately, not just after a reload.
    renderRefusalPanel(container.querySelector('#refusal-panel-translation'), { projectId, settings, kind: 'translation' });
  }

  runBtn.addEventListener('click', () => startRun(0));
  resumeBtn.addEventListener('click', async () => {
    const job = await getJob(projectId);
    startRun(job?.batchIndex ?? 0);
  });

  renderList();
  checkResumable();
  renderRefusalPanel(container.querySelector('#refusal-panel-translation'), { projectId, settings, kind: 'translation' });
}
