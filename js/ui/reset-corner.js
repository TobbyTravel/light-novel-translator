import { db, defaultSettings } from '../storage.js';

// Small always-visible widget (fixed corner, every page) for the two reset
// actions the user wants readily available rather than buried in Settings.
export function renderResetCorner(container, { projectId }) {
  if (!projectId) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <button id="corner-reset-settings" class="danger-btn" title="Reset this project's settings to defaults">Reset settings</button>
    <button id="corner-reset-data" class="danger-btn" title="Delete this project's chapters/bible/synthesis, keep settings">Reset project data</button>
  `;

  container.querySelector('#corner-reset-settings').addEventListener('click', async () => {
    if (!confirm('Reset this project\'s settings (Ollama host, model, languages, context budget) to defaults? Chapters and bible data are kept.')) return;
    const project = await db.get('projects', projectId);
    await db.put('projects', { ...project, settings: defaultSettings() });
    location.reload();
  });

  container.querySelector('#corner-reset-data').addEventListener('click', async () => {
    if (!confirm('Delete this project\'s chapters, story bible, and synthesis? Settings are kept. This cannot be undone.')) return;
    await db.clearProject(projectId);
    location.hash = `#/project/${projectId}`;
    location.reload();
  });
}
