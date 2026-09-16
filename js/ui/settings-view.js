import { listModels } from '../ollama.js';
import { db } from '../storage.js';

export function renderSettingsView(container, { projectId, settings, onChange }) {
  container.innerHTML = `
    <section class="panel">
      <h2>Settings</h2>
      <label>Ollama host <input type="text" id="s-host" value="${settings.ollamaHost}" /></label>
      <label>Model name
        <input type="text" id="s-model" list="s-model-list" value="${settings.model}" placeholder="e.g. hf.co/bartowski/TheDrummer_Cydonia-24B-v4.1-GGUF:Q6_K_L" />
        <datalist id="s-model-list"></datalist>
      </label>
      <button id="s-refresh-models" type="button">Detect installed models</button>
      <label>Source language <input type="text" id="s-source" value="${settings.sourceLanguage}" /></label>
      <label>Target language <input type="text" id="s-target" value="${settings.targetLanguage}" /></label>
      <label>Context budget (tokens)
        <input type="number" id="s-context-budget" value="${settings.contextBudget}" min="256" step="256" />
      </label>
      <p class="muted">For comparison only - not sent to Ollama. Set this to whatever context size you've configured in Ollama itself, so the token estimates in the Bible/Translate views can warn you when a call would exceed it.</p>
      <label>Batch fill target (%)
        <input type="number" id="s-batch-fill" value="${settings.batchFillTarget}" min="10" max="100" step="5" />
      </label>
      <p class="muted">When running extraction/translation on all chapters, consecutive chapters are auto-batched into one call until they'd use this percentage of the context budget, leaving headroom for the model's own output.</p>
      <p id="s-status" class="muted"></p>
      <hr/>
      <div class="row">
        <button id="export-project">Export project (.json)</button>
        <label class="import-label">Import project (.json) <input type="file" id="import-project" accept="application/json" /></label>
      </div>
      <p class="muted">Reset buttons have moved to the corner widget in the bottom-right of every page.</p>
    </section>
  `;

  const el = (id) => container.querySelector(id);
  const statusEl = el('#s-status');

  async function persist() {
    settings.ollamaHost = el('#s-host').value.trim() || 'http://localhost:11434';
    settings.model = el('#s-model').value.trim();
    settings.sourceLanguage = el('#s-source').value.trim() || 'Japanese';
    settings.targetLanguage = el('#s-target').value.trim() || 'English';
    settings.contextBudget = Number(el('#s-context-budget').value) || 16384;
    settings.batchFillTarget = Number(el('#s-batch-fill').value) || 80;
    await db.put('projects', { ...(await db.get('projects', projectId)), settings });
    onChange(settings);
  }

  ['#s-host', '#s-model', '#s-source', '#s-target', '#s-context-budget', '#s-batch-fill'].forEach((sel) => {
    el(sel).addEventListener('change', persist);
  });

  el('#s-refresh-models').addEventListener('click', async () => {
    statusEl.textContent = 'Checking...';
    try {
      const models = await listModels(el('#s-host').value.trim() || settings.ollamaHost);
      el('#s-model-list').innerHTML = models.map((m) => `<option value="${m}"></option>`).join('');
      statusEl.textContent = models.length ? `Found ${models.length} model(s).` : 'Connected, but no models installed.';
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

  el('#export-project').addEventListener('click', async () => {
    const { exportProject } = await import('../storage.js');
    const data = await exportProject(projectId);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const { downloadBlob } = await import('../epub.js');
    const project = await db.get('projects', projectId);
    downloadBlob(blob, `${project.title.replace(/[^\w\-]+/g, '_')}_project.json`);
  });

  el('#import-project').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const { importProject } = await import('../storage.js');
    const data = JSON.parse(await file.text());
    const newProjectId = await importProject(data);
    location.hash = `#/project/${newProjectId}`;
    location.reload();
  });
}
