import { db } from '../../storage.js';
import { runExtraction, planExtractionBatches } from '../../extraction.js';
import { extractionSystemPrompt, extractionUserPrompt } from '../../prompts.js';
import { estimateCallTokens, formatTokenCount } from '../../tokens.js';
import { renderRefusalPanel } from '../refusal-panel.js';
import { createEtaTracker } from '../../eta.js';
import { activityStart, activitySetStatus, activityPushToken, activityFinish, setLiveOutputEnabled } from '../activity.js';
import { getJob } from '../../jobs.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function renderExtractStep(container, { projectId, settings, refreshStepper }) {
  container.innerHTML = `
    <div class="row">
      <button id="run-extraction">Run extraction pass on all chapters</button>
      <button id="resume-extraction" hidden>Resume interrupted run</button>
      <button id="stop-extraction" hidden>Stop</button>
    </div>
    <details id="token-panel"><summary>Token usage per chapter (estimated / actual)</summary></details>
    <div id="refusal-panel-extraction"></div>
  `;

  const tokenPanelEl = container.querySelector('#token-panel');
  const runExtractionBtn = container.querySelector('#run-extraction');
  const resumeExtractionBtn = container.querySelector('#resume-extraction');
  const stopExtractionBtn = container.querySelector('#stop-extraction');

  async function checkResumable() {
    const job = await getJob(projectId);
    resumeExtractionBtn.hidden = !(job && job.kind === 'extraction' && job.status === 'interrupted');
    return job;
  }

  async function renderTokenPanel() {
    const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
    const batches = planExtractionBatches(chapters, settings);
    let total = 0;
    const rows = batches.map((batch, bIdx) => {
      const chapterTitles = batch.map((c) => c.title);
      const system = extractionSystemPrompt({ sourceLanguage: settings.sourceLanguage, chapterTitles });
      const estimated = estimateCallTokens({ system, prompt: extractionUserPrompt({ chapters: batch }) });
      const actual = batch[0].extractionPromptTokens;
      const used = actual ?? estimated;
      total += used;
      const overBudget = used > settings.contextBudget;
      const stripe = bIdx % 2 === 0 ? 'batch-stripe-a' : 'batch-stripe-b';
      const label = batch.length === 1
        ? `${batch[0].index + 1}. ${escapeHtml(batch[0].title)}`
        : `${batch[0].index + 1}-${batch[batch.length - 1].index + 1}. ${escapeHtml(batch[0].title)} .. ${escapeHtml(batch[batch.length - 1].title)} (batch of ${batch.length})`;
      return `<tr class="${stripe} ${overBudget ? 'over-budget' : ''}">
        <td>${label}</td>
        <td>${formatTokenCount(estimated)} est.</td>
        <td>${actual != null ? `${formatTokenCount(actual)} actual` : '<span class="muted">not run yet</span>'}</td>
        ${overBudget ? '<td class="warn">⚠ exceeds context budget</td>' : '<td></td>'}
      </tr>`;
    }).join('');
    tokenPanelEl.innerHTML = `
      <summary>Token usage per call (${batches.length} call(s) for ${chapters.length} chapter(s)) - total ~${formatTokenCount(total)} tokens against a ${formatTokenCount(settings.contextBudget)} budget</summary>
      <table class="bible-table"><thead><tr><th>Chapters</th><th>Estimated</th><th>Actual</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
    `;
  }

  async function startExtraction(startBatchIndex = 0) {
    const existingJob = await getJob(projectId);
    if (existingJob?.status === 'running') {
      alert(`A ${existingJob.kind} job is already running for this project - wait for it to finish or stop it first.`);
      return;
    }
    if (!settings.model) {
      alert('Set an Ollama model name in Settings first.');
      return;
    }
    runExtractionBtn.disabled = true;
    resumeExtractionBtn.disabled = true;
    stopExtractionBtn.hidden = false;
    const controller = new AbortController();
    stopExtractionBtn.onclick = () => {
      stopExtractionBtn.disabled = true;
      controller.abort();
    };
    const originalTitle = document.title;
    const eta = createEtaTracker();
    const chapters = await db.allByProject('chapters', projectId);
    chapters.sort((a, b) => a.index - b.index);
    setLiveOutputEnabled(settings.liveOutput);
    activityStart();
    const errors = [];
    await runExtraction({
      projectId,
      chapters,
      settings,
      startBatchIndex,
      signal: controller.signal,
      onToken: (chunk, full) => activityPushToken(chunk, full),
      onProgress: async ({ index, total, batch, done, estimatedTokens, promptTokens, aborted }) => {
        const batchLabel = batch && batch.length > 1 ? `${batch.length} chapters (${batch[0].title} .. ${batch[batch.length - 1].title})` : batch?.[0]?.title;
        if (done) {
          activitySetStatus(aborted
            ? `Stopped by request (${index}/${total} batches done, ${errors.length} failed).`
            : `Done (${errors.length} chapter(s) failed)`);
          activityFinish();
          document.title = originalTitle;
        } else if (promptTokens != null) {
          const remaining = eta.estimate(index + 1, total - (index + 1));
          activitySetStatus(`Batch ${index + 1}/${total}: ${batchLabel} (used ${formatTokenCount(promptTokens)} tokens)${remaining ? ` - ${remaining}` : ''}`);
          document.title = `[${index + 1}/${total}] ${originalTitle}`;
          await renderTokenPanel();
        } else {
          const remaining = eta.estimate(index, total - index);
          activitySetStatus(`Batch ${index + 1}/${total}: ${batchLabel} (~${formatTokenCount(estimatedTokens)} tokens est.)${remaining ? ` - ${remaining}` : ''}`);
        }
      },
      onChapterError: ({ chapter, error }) => {
        errors.push(chapter);
        console.error(`Extraction failed for "${chapter.title}"`, error);
      },
    });
    runExtractionBtn.disabled = false;
    resumeExtractionBtn.disabled = false;
    stopExtractionBtn.hidden = true;
    stopExtractionBtn.disabled = false;
    await renderTokenPanel();
    await checkResumable();
    await refreshStepper?.();
    // Chapters get flagged as each call completes (js/extraction.js), not
    // only via a manual "Run crosscheck" click - refresh the panel so a
    // flag from this run is visible immediately, not just after a reload.
    renderRefusalPanel(container.querySelector('#refusal-panel-extraction'), { projectId, settings, kind: 'extraction' });
  }

  runExtractionBtn.addEventListener('click', () => startExtraction(0));
  resumeExtractionBtn.addEventListener('click', async () => {
    const job = await getJob(projectId);
    startExtraction(job?.batchIndex ?? 0);
  });

  renderTokenPanel();
  checkResumable();
  renderRefusalPanel(container.querySelector('#refusal-panel-extraction'), { projectId, settings, kind: 'extraction' });
}
