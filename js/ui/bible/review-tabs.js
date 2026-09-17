import { db } from '../../storage.js';
import { renderEntityTable } from './entity-table.js';

const TABS = [
  { key: 'characters', label: 'Characters', fields: ['sourceName', 'englishName', 'aliases', 'honorifics', 'speechStyle', 'role', 'notes'], hasEvidence: true },
  { key: 'relationships', label: 'Relationships', fields: ['characterA', 'characterB', 'type', 'speechRegisterNotes', 'notes'], hasEvidence: false },
  { key: 'locations', label: 'Locations', fields: ['sourceName', 'englishName', 'description'], hasEvidence: true },
  { key: 'terminology', label: 'Terminology', fields: ['sourceTerm', 'englishRendering', 'category', 'notes'], hasEvidence: true },
  { key: 'timeline', label: 'Timeline', fields: ['chapterTitle', 'summary', 'keyEvents'], hasEvidence: false },
];

export async function renderReviewTabs(container, { projectId }) {
  let activeTab = 'characters';

  container.innerHTML = `
    <div class="tabs" id="bible-tabs"></div>
    <div id="bible-tab-content"></div>
  `;
  const tabsEl = container.querySelector('#bible-tabs');
  const contentEl = container.querySelector('#bible-tab-content');

  const counts = await Promise.all(TABS.map((t) => db.allByProject(t.key, projectId).then((r) => r.length)));

  function renderTabBar() {
    tabsEl.innerHTML = TABS.map((t, i) =>
      `<button class="tab-btn ${t.key === activeTab ? 'active' : ''}" data-tab="${t.key}">${t.label} (${counts[i]})</button>`
    ).join('');
    tabsEl.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderTabBar();
        renderActiveTab();
      });
    });
  }

  function renderActiveTab() {
    const tab = TABS.find((t) => t.key === activeTab);
    renderEntityTable(contentEl, { projectId, tab });
  }

  renderTabBar();
  renderActiveTab();
}
