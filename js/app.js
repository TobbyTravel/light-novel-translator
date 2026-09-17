import { db, defaultSettings } from './storage.js';
import { renderImportView } from './ui/import-view.js';
import { renderBibleView } from './ui/bible-view.js';
import { renderTranslateView } from './ui/translate-view.js';
import { renderExportView } from './ui/export-view.js';
import { renderSettingsView } from './ui/settings-view.js';
import { renderResetCorner } from './ui/reset-corner.js';
import { renderStatusBar } from './ui/status-bar.js';
import { markStaleJobsInterrupted } from './jobs.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const resetCorner = document.getElementById('reset-corner');
const statusBar = document.getElementById('status-bar');

let currentProjectId = null;
let currentSettings = defaultSettings();
let activeView = 'import';

function parseHash() {
  const match = location.hash.match(/^#\/project\/([^/]+)(?:\/(\w+))?(?:\/(\w+))?/);
  if (match) return { projectId: match[1], view: match[2] || 'bible', step: match[3] };
  return { projectId: null, view: 'import', step: undefined };
}

async function loadProjectSettings(projectId) {
  const project = await db.get('projects', projectId);
  return { ...defaultSettings(), ...(project?.settings || {}) };
}

function renderNav() {
  if (!currentProjectId) {
    nav.innerHTML = '';
    return;
  }
  const views = [
    { key: 'bible', label: 'Story Bible' },
    { key: 'translate', label: 'Translate' },
    { key: 'export', label: 'Review & Export' },
    { key: 'settings', label: 'Settings' },
  ];
  nav.innerHTML = `
    <button data-view="import" class="nav-btn">+ New project</button>
    ${views.map((v) => `<button data-view="${v.key}" class="nav-btn ${v.key === activeView ? 'active' : ''}">${v.label}</button>`).join('')}
  `;
  nav.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'import') {
        location.hash = '';
      } else {
        location.hash = `#/project/${currentProjectId}/${btn.dataset.view}`;
      }
    });
  });
}

async function render() {
  const { projectId, view, step } = parseHash();
  currentProjectId = projectId;
  activeView = view;

  if (!projectId) {
    renderNav();
    renderResetCorner(resetCorner, { projectId: null });
    renderStatusBar(statusBar, { projectId: null });
    renderImportView(app, {
      onProjectReady: (newProjectId) => {
        location.hash = `#/project/${newProjectId}/bible`;
      },
    });
    return;
  }

  currentSettings = await loadProjectSettings(projectId);
  renderNav();
  renderResetCorner(resetCorner, { projectId });
  renderStatusBar(statusBar, { projectId });

  const commonProps = { projectId, settings: currentSettings };
  if (view === 'translate') renderTranslateView(app, commonProps);
  else if (view === 'export') renderExportView(app, commonProps);
  else if (view === 'settings') {
    renderSettingsView(app, { ...commonProps, onChange: (s) => { currentSettings = s; } });
  } else renderBibleView(app, { ...commonProps, step });
}

window.addEventListener('hashchange', render);
markStaleJobsInterrupted().then(render);
