// Generic inline-editable table for one entity store (characters,
// relationships, locations, terminology, timeline) - the five stores only
// differ by which fields/columns they expose, described by the `tab` param
// (see review-tabs.js), so this one renderer covers all of them instead of
// five near-duplicate table-rendering functions.
import { db } from '../../storage.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function isVerified(evidence) {
  return (evidence || []).some((e) => e.verified);
}

function evidenceSummary(evidence) {
  if (!evidence || evidence.length === 0) return '<span class="muted">no evidence</span>';
  return evidence.map((e) =>
    `<div class="evidence-item ${e.verified ? 'verified' : 'unverified'}">` +
    `${e.verified ? '✓' : '⚠'} <em>${escapeHtml(e.chapterTitle)}</em>: "${escapeHtml(e.quote)}"</div>`
  ).join('');
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

export async function renderEntityTable(container, { projectId, tab }) {
  const records = await db.allByProject(tab.key, projectId);
  container.innerHTML = `
    <table class="bible-table">
      <thead><tr>
        ${tab.hasEvidence ? '<th>grounded</th>' : ''}
        ${tab.fields.map((f) => `<th>${f}</th>`).join('')}
      </tr></thead>
      <tbody>
        ${records.map((r) => `
          <tr data-id="${r.id}">
            ${tab.hasEvidence ? `<td class="verify-cell">
              <span class="verify-badge ${isVerified(r.evidence) ? 'verified' : 'unverified'}" title="click to see evidence">
                ${isVerified(r.evidence) ? '✓' : '⚠'}
              </span>
            </td>` : ''}
            ${tab.fields.map((f) => `<td contenteditable="true" data-field="${f}">${escapeHtml(formatField(r[f]))}</td>`).join('')}
          </tr>
          ${tab.hasEvidence ? `<tr class="evidence-row" data-evidence-for="${r.id}" hidden><td colspan="${tab.fields.length + 1}">${evidenceSummary(r.evidence)}</td></tr>` : ''}
        `).join('')}
      </tbody>
    </table>
    ${records.length === 0 ? '<p class="muted">No entries yet - run the extraction pass first.</p>' : ''}
  `;

  container.querySelectorAll('.verify-badge').forEach((badge) => {
    badge.addEventListener('click', () => {
      const id = badge.closest('tr').dataset.id;
      const row = container.querySelector(`tr.evidence-row[data-evidence-for="${id}"]`);
      if (row) row.hidden = !row.hidden;
    });
  });

  container.querySelectorAll('td[contenteditable]').forEach((cell) => {
    cell.addEventListener('blur', async () => {
      const row = cell.closest('tr');
      const id = row.dataset.id;
      const field = cell.dataset.field;
      const record = records.find((r) => r.id === id);
      record[field] = parseField(field, cell.textContent);
      await db.put(tab.key, record);
    });
  });
}
