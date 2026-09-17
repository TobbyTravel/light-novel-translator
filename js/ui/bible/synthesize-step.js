import { db } from '../../storage.js';
import { runSynthesis, planSynthesisRun } from '../../synthesis.js';
import { formatTokenCount } from '../../tokens.js';
import { createLiveOutputPanel } from '../live-output.js';
import { getJob } from '../../jobs.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function renderSynthesizeStep(container, { projectId, settings, refreshStepper }) {
  container.innerHTML = `
    <div id="live-output-synthesis"></div>
    <div id="synthesis-panel"></div>
  `;
  const liveOutput = createLiveOutputPanel(container.querySelector('#live-output-synthesis'));
  const synthesisPanelEl = container.querySelector('#synthesis-panel');

  async function renderSynthesisPanel(statusOverride) {
    const timeline = await db.allByProject('timeline', projectId);
    const synthesis = await db.get('synthesis', projectId);
    const plan = timeline.length > 0 ? planSynthesisRun({ timelineEntries: timeline, settings }) : null;

    const planLine = plan
      ? plan.mode === 'single'
        ? `Will run as 1 call (~${formatTokenCount(plan.estimatedTokens)} tokens).`
        : `Novel summaries are large - will run as ${plan.batchCount} batch call(s) + 1 combine call.`
      : 'No timeline entries yet - run extraction first.';

    synthesisPanelEl.innerHTML = `
      <div class="panel synthesis-box">
        <div class="row">
          <button id="run-synthesis" ${timeline.length === 0 ? 'disabled' : ''}>${synthesis ? 'Regenerate' : 'Generate'} story synthesis</button>
          <span class="muted">${statusOverride || planLine}</span>
        </div>
        ${synthesis ? `
          <label>Synopsis <textarea id="syn-synopsis" rows="4">${escapeHtml(synthesis.synopsis)}</textarea></label>
          <label>Tone notes <textarea id="syn-tone" rows="2">${escapeHtml(synthesis.toneNotes)}</textarea></label>
          <strong>Character arcs</strong>
          <table class="bible-table"><thead><tr><th>Character</th><th>Arc</th></tr></thead><tbody>
            ${(synthesis.characterArcs || []).map((a, i) => `
              <tr data-idx="${i}">
                <td contenteditable="true" data-field="character">${escapeHtml(a.character)}</td>
                <td contenteditable="true" data-field="arc">${escapeHtml(a.arc)}</td>
              </tr>`).join('')}
          </tbody></table>
          <strong>Foreshadowing</strong>
          <table class="bible-table"><thead><tr><th>Note</th><th>Setup ch.</th><th>Payoff ch.</th></tr></thead><tbody>
            ${(synthesis.foreshadowing || []).map((f, i) => `
              <tr data-idx="${i}">
                <td contenteditable="true" data-field="note">${escapeHtml(f.note)}</td>
                <td contenteditable="true" data-field="setupChapter">${f.setupChapter ?? ''}</td>
                <td contenteditable="true" data-field="payoffChapter">${f.payoffChapter ?? ''}</td>
              </tr>`).join('')}
          </tbody></table>
          <p class="muted">Generated ${new Date(synthesis.generatedAt).toLocaleString()}</p>
        ` : ''}
      </div>
    `;

    if (!synthesis) return;

    synthesisPanelEl.querySelector('#syn-synopsis').addEventListener('blur', async (e) => {
      const current = await db.get('synthesis', projectId);
      current.synopsis = e.target.value;
      await db.put('synthesis', current);
    });
    synthesisPanelEl.querySelector('#syn-tone').addEventListener('blur', async (e) => {
      const current = await db.get('synthesis', projectId);
      current.toneNotes = e.target.value;
      await db.put('synthesis', current);
    });
    synthesisPanelEl.querySelectorAll('td[contenteditable]').forEach((cell) => {
      cell.addEventListener('blur', async () => {
        const row = cell.closest('tr');
        const idx = Number(row.dataset.idx);
        const field = cell.dataset.field;
        const listKey = row.closest('table').querySelector('th').textContent === 'Character' ? 'characterArcs' : 'foreshadowing';
        const current = await db.get('synthesis', projectId);
        const list = current[listKey] || [];
        if (!list[idx]) return;
        list[idx][field] = field.endsWith('Chapter') ? Number(cell.textContent) || null : cell.textContent.trim();
        await db.put('synthesis', current);
      });
    });
  }

  synthesisPanelEl.addEventListener('click', async (e) => {
    if (e.target.id !== 'run-synthesis') return;
    const existingJob = await getJob(projectId);
    if (existingJob?.status === 'running') {
      alert(`A ${existingJob.kind} job is already running for this project - wait for it to finish or stop it first.`);
      return;
    }
    if (!settings.model) {
      alert('Set an Ollama model name in Settings first.');
      return;
    }
    e.target.disabled = true;
    await renderSynthesisPanel('Running...');
    liveOutput.reset();
    try {
      await runSynthesis({
        projectId,
        settings,
        onToken: (chunk, full) => liveOutput.onToken(chunk, full),
        onProgress: ({ stage, batch, totalBatches }) => {
          const label = stage === 'reduce' ? 'Combining batch summaries...' : `Batch ${batch}/${totalBatches}...`;
          renderSynthesisPanel(label);
        },
      });
      await refreshStepper?.();
    } catch (err) {
      alert(`Synthesis failed: ${err.message}`);
    }
    await renderSynthesisPanel();
  });

  renderSynthesisPanel();
}
