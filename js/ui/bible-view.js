import { db, ENTITY_STORES } from '../storage.js';
import { runExtraction, detectDuplicates, mergeDuplicateRecords, planExtractionBatches } from '../extraction.js';
import { extractionSystemPrompt, extractionUserPrompt } from '../prompts.js';
import { estimateCallTokens, formatTokenCount } from '../tokens.js';
import { runSynthesis, planSynthesisRun } from '../synthesis.js';
import { renderRefusalPanel } from './refusal-panel.js';

const TABS = [
  { key: 'characters', label: 'Characters', fields: ['sourceName', 'englishName', 'aliases', 'honorifics', 'speechStyle', 'role', 'notes'], hasEvidence: true },
  { key: 'relationships', label: 'Relationships', fields: ['characterA', 'characterB', 'type', 'speechRegisterNotes', 'notes'], hasEvidence: false },
  { key: 'locations', label: 'Locations', fields: ['sourceName', 'englishName', 'description'], hasEvidence: true },
  { key: 'terminology', label: 'Terminology', fields: ['sourceTerm', 'englishRendering', 'category', 'notes'], hasEvidence: true },
  { key: 'timeline', label: 'Timeline', fields: ['chapterTitle', 'summary', 'keyEvents'], hasEvidence: false },
];

function isVerified(evidence) {
  return (evidence || []).some((e) => e.verified);
}

function evidenceSummary(evidence) {
  if (!evidence || evidence.length === 0) return '<span class="muted">no evidence</span>';
  return evidence.map((e) =>
    `<div class="evidence-item ${e.verified ? 'verified' : 'unverified'}">` +
    `${e.verified ? '✓' : '⚠'} <em>${escapeHtml(e.chapterTitle)}</em>: “${escapeHtml(e.quote)}”</div>`
  ).join('');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function renderBibleView(container, { projectId, settings }) {
  let activeTab = 'characters';

  container.innerHTML = `
    <section class="panel">
      <h2>2. Story bible</h2>
      <div class="row">
        <button id="run-extraction">Run extraction pass on all chapters</button>
        <span id="extraction-status" class="muted"></span>
      </div>
      <details id="token-panel"><summary>Token usage per chapter (estimated / actual)</summary></details>
      <div id="synthesis-panel"></div>
      <div id="refusal-panel-extraction"></div>
      <div id="duplicates-panel"></div>
      <div class="tabs" id="bible-tabs"></div>
      <div id="bible-tab-content"></div>
    </section>
  `;

  const tabsEl = container.querySelector('#bible-tabs');
  const contentEl = container.querySelector('#bible-tab-content');
  const statusEl = container.querySelector('#extraction-status');
  const duplicatesEl = container.querySelector('#duplicates-panel');
  const tokenPanelEl = container.querySelector('#token-panel');
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

  function renderTabs() {
    tabsEl.innerHTML = TABS.map((t) =>
      `<button class="tab-btn ${t.key === activeTab ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>`
    ).join('');
    tabsEl.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderTabs();
        renderContent();
      });
    });
  }

  async function renderContent() {
    const tab = TABS.find((t) => t.key === activeTab);
    const records = await db.allByProject(tab.key, projectId);
    contentEl.innerHTML = `
      <table class="bible-table">
        <thead><tr>
          ${tab.hasEvidence ? '<th>grounded</th>' : ''}
          ${tab.fields.map((f) => `<th>${f}</th>`).join('')}
          ${tab.key !== 'timeline' ? '<th>approved</th>' : ''}
        </tr></thead>
        <tbody>
          ${records.map((r) => `
            <tr data-id="${r.id}">
              ${tab.hasEvidence ? `<td class="verify-cell">
                <span class="verify-badge ${isVerified(r.evidence) ? 'verified' : 'unverified'}" title="click to see evidence">
                  ${isVerified(r.evidence) ? '✓' : '⚠'}
                </span>
              </td>` : ''}
              ${tab.fields.map((f) => `<td contenteditable="true" data-field="${f}">${formatField(r[f])}</td>`).join('')}
              ${tab.key !== 'timeline' ? `<td><input type="checkbox" data-field="approved" ${r.approved ? 'checked' : ''}/></td>` : ''}
            </tr>
            ${tab.hasEvidence ? `<tr class="evidence-row" data-evidence-for="${r.id}" hidden><td colspan="${tab.fields.length + 2}">${evidenceSummary(r.evidence)}</td></tr>` : ''}
          `).join('')}
        </tbody>
      </table>
      ${records.length === 0 ? '<p class="muted">No entries yet - run the extraction pass above.</p>' : ''}
    `;

    contentEl.querySelectorAll('.verify-badge').forEach((badge) => {
      badge.addEventListener('click', () => {
        const id = badge.closest('tr').dataset.id;
        const row = contentEl.querySelector(`tr.evidence-row[data-evidence-for="${id}"]`);
        if (row) row.hidden = !row.hidden;
      });
    });

    contentEl.querySelectorAll('td[contenteditable]').forEach((cell) => {
      cell.addEventListener('blur', async () => {
        const row = cell.closest('tr');
        const id = row.dataset.id;
        const field = cell.dataset.field;
        const record = records.find((r) => r.id === id);
        record[field] = parseField(field, cell.textContent);
        await db.put(tab.key, record);
      });
    });

    contentEl.querySelectorAll('input[type=checkbox][data-field=approved]').forEach((box) => {
      box.addEventListener('change', async () => {
        const row = box.closest('tr');
        const id = row.dataset.id;
        const record = records.find((r) => r.id === id);
        record.approved = box.checked;
        await db.put(tab.key, record);
      });
    });
  }

  function formatField(value) {
    if (Array.isArray(value)) return value.join(', ');
    return value ?? '';
  }

  function parseField(field, text) {
    if (field === 'aliases' || field === 'keyEvents') {
      return text.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return text.trim();
  }

  async function renderDuplicates() {
    const dupes = await detectDuplicates(projectId);
    const nameField = { characters: 'sourceName', locations: 'sourceName', terminology: 'sourceTerm' };
    const allPairs = Object.entries(dupes).flatMap(([store, pairs]) => pairs.map((p) => ({ store, pairs: p })));
    if (allPairs.length === 0) {
      duplicatesEl.innerHTML = '';
      return;
    }
    duplicatesEl.innerHTML = `
      <div class="panel duplicates-box">
        <strong>Possible duplicates (${allPairs.length})</strong> - not merged automatically, review each:
        ${allPairs.map(({ store, pairs: [a, b] }, i) => `
          <div class="row dup-row">
            <span>${escapeHtml(a[nameField[store]])} &harr; ${escapeHtml(b[nameField[store]])} (${store})</span>
            <button class="merge-dup-btn" data-store="${store}" data-keep="${a.id}" data-drop="${b.id}">Merge into "${escapeHtml(a[nameField[store]])}"</button>
            <button class="merge-dup-btn" data-store="${store}" data-keep="${b.id}" data-drop="${a.id}">Merge into "${escapeHtml(b[nameField[store]])}"</button>
          </div>
        `).join('')}
      </div>
    `;
    duplicatesEl.querySelectorAll('.merge-dup-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const { store, keep, drop } = btn.dataset;
        const keepRecord = await db.get(store, keep);
        const dropRecord = await db.get(store, drop);
        await mergeDuplicateRecords(store, keepRecord, dropRecord);
        await renderDuplicates();
        if (activeTab === store) await renderContent();
      });
    });
  }

  container.querySelector('#run-extraction').addEventListener('click', async () => {
    if (!settings.model) {
      alert('Set an Ollama model name in Settings first.');
      return;
    }
    const chapters = await db.allByProject('chapters', projectId);
    chapters.sort((a, b) => a.index - b.index);
    statusEl.textContent = 'Running...';
    const errors = [];
    await runExtraction({
      projectId,
      chapters,
      settings,
      onProgress: async ({ index, total, batch, done, estimatedTokens, promptTokens }) => {
        const batchLabel = batch && batch.length > 1 ? `${batch.length} chapters (${batch[0].title} .. ${batch[batch.length - 1].title})` : batch?.[0]?.title;
        if (done) {
          statusEl.textContent = `Done (${errors.length} chapter(s) failed)`;
        } else if (promptTokens != null) {
          statusEl.textContent = `Batch ${index + 1}/${total}: ${batchLabel} (used ${formatTokenCount(promptTokens)} tokens)`;
          await renderTokenPanel();
        } else {
          statusEl.textContent = `Batch ${index + 1}/${total}: ${batchLabel} (~${formatTokenCount(estimatedTokens)} tokens est.)`;
        }
      },
      onChapterError: ({ chapter, error }) => {
        errors.push(chapter);
        console.error(`Extraction failed for "${chapter.title}"`, error);
      },
    });
    await renderContent();
    await renderDuplicates();
    await renderTokenPanel();
    await renderSynthesisPanel();
  });

  synthesisPanelEl.addEventListener('click', async (e) => {
    if (e.target.id !== 'run-synthesis') return;
    if (!settings.model) {
      alert('Set an Ollama model name in Settings first.');
      return;
    }
    e.target.disabled = true;
    await renderSynthesisPanel('Running...');
    try {
      await runSynthesis({
        projectId,
        settings,
        onProgress: ({ stage, batch, totalBatches }) => {
          const label = stage === 'reduce' ? 'Combining batch summaries...' : `Batch ${batch}/${totalBatches}...`;
          renderSynthesisPanel(label);
        },
      });
    } catch (err) {
      alert(`Synthesis failed: ${err.message}`);
    }
    await renderSynthesisPanel();
  });

  renderTabs();
  renderContent();
  renderDuplicates();
  renderSynthesisPanel();
  renderTokenPanel();
  renderRefusalPanel(container.querySelector('#refusal-panel-extraction'), { projectId, settings, kind: 'extraction' });
}
