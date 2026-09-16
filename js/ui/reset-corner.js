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
    const project = await db.get('projects', projectId);
    const title = project?.title || 'this project';
    const typed = prompt(
      `This permanently deletes all chapters, story bible entries, and synthesis for "${title}". ` +
      `Settings are kept. This cannot be undone.\n\nType the project title to confirm: ${title}`
    );
    if (typed !== title) {
      if (typed !== null) alert('Title did not match - nothing was deleted.');
      return;
    }
    await db.clearProject(projectId);
    location.hash = `#/project/${projectId}`;
    location.reload();
  });
}
