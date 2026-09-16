import { db } from '../storage.js';
import { runTranslationCrosscheck, runExtractionCrosscheck, retryWithFallbackChain, exportRefusalReport } from '../crosscheck.js';
import { downloadBlob } from '../epub.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const OUTPUT_FIELD = { translation: 'translatedText', extraction: 'extractionRawResponse' };

// Shared panel for both the Bible view (kind: 'extraction') and Translate
// view (kind: 'translation'). Crosscheck itself is a pure local scan; only
// the retry action calls Ollama.
export function renderRefusalPanel(container, { projectId, settings, kind }) {
  container.innerHTML = `
    <details class="panel refusal-box">
      <summary>Refusal / censorship crosscheck</summary>
      <div class="row">
        <button id="run-crosscheck-${kind}">Run crosscheck</button>
        <button id="export-refusal-${kind}">Export refusal report (.json)</button>
        <span class="muted" id="crosscheck-status-${kind}"></span>
      </div>
      <div id="flagged-list-${kind}"></div>
    </details>
  `;

  const statusEl = container.querySelector(`#crosscheck-status-${kind}`);
  const listEl = container.querySelector(`#flagged-list-${kind}`);

  async function renderFlagged() {
    const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
    const flagged = chapters.filter((c) => c.refusalFlags?.[kind]);
    if (flagged.length === 0) {
      listEl.innerHTML = '<p class="muted">No flagged chapters (run the crosscheck above).</p>';
      return;
    }
    listEl.innerHTML = flagged.map((c) => {
      const flag = c.refusalFlags[kind];
      const attempts = c.refusalAttempts?.[kind] || [];
      const lastOutput = attempts[attempts.length - 1]?.output || c[OUTPUT_FIELD[kind]] || '';
      return `
        <details class="flagged-chapter" data-id="${c.id}">
          <summary>${c.index + 1}. ${escapeHtml(c.title)} - ${flag.reasons.length} reason(s)</summary>
          <ul>${flag.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
          <p><strong>Current output:</strong></p>
          <textarea readonly rows="6">${escapeHtml(lastOutput)}</textarea>
          <div class="row">
            <button class="retry-fallback-btn" data-id="${c.id}">Retry via fallback chain</button>
            <span class="muted retry-status"></span>
          </div>
          ${attempts.length > 0 ? `
            <details><summary>Attempt history (${attempts.length})</summary>
              ${attempts.map((a, i) => `
                <div class="attempt-item ${a.flagged ? 'unverified' : 'verified'}">
                  <strong>Attempt ${i + 1} - ${escapeHtml(a.model)}</strong> ${a.flagged ? '⚠ flagged' : '✓ clean'}
                  <br/>${a.reasons?.map(escapeHtml).join('; ') || ''}
                  <textarea readonly rows="4">${escapeHtml(a.output)}</textarea>
                </div>
              `).join('')}
            </details>` : ''}
        </details>
      `;
    }).join('');

    listEl.querySelectorAll('.retry-fallback-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!settings.fallbackModels || settings.fallbackModels.filter(Boolean).length === 0) {
          alert('Configure at least one fallback model in Settings first.');
          return;
        }
        const chapterId = btn.dataset.id;
        const statusSpan = btn.closest('.row').querySelector('.retry-status');
        btn.disabled = true;
        const chapter = await db.get('chapters', chapterId);
        try {
          await retryWithFallbackChain({
            projectId,
            chapter,
            settings,
            kind,
            onAttempt: ({ index, total, model }) => {
              statusSpan.textContent = `Trying ${index + 1}/${total}: ${model}...`;
            },
          });
        } catch (err) {
          alert(`Retry failed: ${err.message}`);
        }
        await renderFlagged();
      });
    });
  }

  container.querySelector(`#run-crosscheck-${kind}`).addEventListener('click', async () => {
    statusEl.textContent = 'Scanning...';
    const runner = kind === 'translation' ? runTranslationCrosscheck : runExtractionCrosscheck;
    const flaggedCount = await runner({ projectId });
    statusEl.textContent = `${flaggedCount} chapter(s) flagged.`;
    await renderFlagged();
  });

  container.querySelector(`#export-refusal-${kind}`).addEventListener('click', async () => {
    const report = await exportRefusalReport(projectId);
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `refusal_report_${new Date().toISOString().slice(0, 10)}.json`);
  });

  renderFlagged();
}
