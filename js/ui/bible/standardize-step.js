import { runStandardizeNames, applyStandardNameProposal } from '../../standardize.js';
import { createLiveOutputPanel } from '../live-output.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function renderStandardizeStep(container, { projectId, settings }) {
  container.innerHTML = `
    <div class="row">
      <button id="run-standardize">Standardize names (propose English renderings)</button>
      <span id="standardize-status" class="muted">Extracted names stay in the original language; this proposes consistent English renderings from all evidence gathered so far, for you to review.</span>
    </div>
    <div id="live-output-standardize"></div>
    <div id="standardize-panel"></div>
  `;

  const standardizeStatusEl = container.querySelector('#standardize-status');
  const standardizePanelEl = container.querySelector('#standardize-panel');
  const liveOutput = createLiveOutputPanel(container.querySelector('#live-output-standardize'));
  let standardizeProposals = [];

  function renderStandardizePanel() {
    if (standardizeProposals.length === 0) {
      standardizePanelEl.innerHTML = '';
      return;
    }
    standardizePanelEl.innerHTML = `
      <div class="panel duplicates-box">
        <div class="row">
          <strong>Proposed English renderings (${standardizeProposals.length})</strong>
          <button id="accept-all-standardize">Accept all</button>
        </div>
        ${standardizeProposals.map((p, i) => `
          <div class="row dup-row" data-idx="${i}">
            <span>${escapeHtml(p.key)}: ${p.currentEnglish ? `<s>${escapeHtml(p.currentEnglish)}</s> &rarr; ` : ''}<strong>${escapeHtml(p.proposedEnglish)}</strong>${p.reason ? ` <span class="muted">(${escapeHtml(p.reason)})</span>` : ''} <span class="muted">[${p.store}]</span></span>
            <button class="accept-standardize-btn" data-idx="${i}">Accept</button>
            <button class="reject-standardize-btn" data-idx="${i}">Reject</button>
          </div>
        `).join('')}
      </div>
    `;
    standardizePanelEl.querySelectorAll('.accept-standardize-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.idx);
        await applyStandardNameProposal(standardizeProposals[idx]);
        standardizeProposals.splice(idx, 1);
        renderStandardizePanel();
      });
    });
    standardizePanelEl.querySelectorAll('.reject-standardize-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        standardizeProposals.splice(idx, 1);
        renderStandardizePanel();
      });
    });
    standardizePanelEl.querySelector('#accept-all-standardize').addEventListener('click', async () => {
      for (const p of standardizeProposals) await applyStandardNameProposal(p);
      standardizeProposals = [];
      renderStandardizePanel();
    });
  }

  container.querySelector('#run-standardize').addEventListener('click', async (e) => {
    if (!settings.model) {
      alert('Set an Ollama model name in Settings first.');
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    liveOutput.reset();
    try {
      standardizeProposals = await runStandardizeNames({
        projectId,
        settings,
        onToken: (chunk, full) => liveOutput.onToken(chunk, full),
        onProgress: ({ store, index, total, done }) => {
          standardizeStatusEl.textContent = done
            ? `Done - ${standardizeProposals.length} proposal(s) to review below.`
            : `Analyzing ${store} (${index + 1}/${total})...`;
        },
      });
      if (standardizeProposals.length === 0) {
        standardizeStatusEl.textContent = 'Done - no changes proposed (all current renderings already look best, or nothing to name yet).';
      }
      renderStandardizePanel();
    } catch (err) {
      standardizeStatusEl.textContent = `Failed: ${err.message}`;
    }
    btn.disabled = false;
  });
}
