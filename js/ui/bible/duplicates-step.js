import { db } from '../../storage.js';
import { detectDuplicates, mergeDuplicateRecords, autoResolveDuplicates } from '../../extraction.js';

const nameField = { characters: 'sourceName', locations: 'sourceName', terminology: 'sourceTerm' };

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function renderDuplicatesStep(container, { projectId, settings, refreshStepper }) {
  container.innerHTML = `<div id="duplicates-panel"></div>`;
  const duplicatesEl = container.querySelector('#duplicates-panel');

  // Accepts an already-fetched `dupes` result when the caller (a merge
  // handler below) just computed one anyway, so a merge triggers exactly
  // one detectDuplicates() scan shared between this panel and the stepper
  // refresh, not two back-to-back full O(n^2) scans.
  function renderDuplicates(dupes) {
    const allPairs = Object.entries(dupes).flatMap(([store, pairs]) => pairs.map((p) => ({ store, pairs: p })));
    if (allPairs.length === 0) {
      duplicatesEl.innerHTML = '<p class="muted">No possible duplicates found - run extraction first if this looks empty unexpectedly.</p>';
      return;
    }
    duplicatesEl.innerHTML = `
      <div class="panel duplicates-box">
        <div class="row">
          <strong>Possible duplicates (${allPairs.length})</strong>
          <button id="auto-resolve-dupes">Auto-resolve all (best guess)</button>
        </div>
        <p class="muted">Or review each individually:</p>
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
        await refreshAfterChange();
      });
    });
    duplicatesEl.querySelector('#auto-resolve-dupes').addEventListener('click', async () => {
      const btn = duplicatesEl.querySelector('#auto-resolve-dupes');
      btn.disabled = true;
      btn.textContent = settings.model ? 'Resolving via AI...' : 'Resolving...';
      await autoResolveDuplicates(projectId, settings);
      await refreshAfterChange();
    });
  }

  async function refreshAfterChange() {
    const dupes = await detectDuplicates(projectId);
    renderDuplicates(dupes);
    await refreshStepper?.({ duplicates: dupes });
  }

  refreshAfterChange();
}
