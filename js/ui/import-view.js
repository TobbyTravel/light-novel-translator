import { splitIntoChapters, splitByLineCount, HEADER_PATTERN_CATEGORIES, DEFAULT_ACTIVE_PATTERN_KEYS } from '../splitter.js';
import { db, newId, defaultSettings, importProject } from '../storage.js';
import { planExtractionBatches } from '../extraction.js';
import { estimateTokens, formatTokenCount } from '../tokens.js';

const PATTERN_PREF_KEY = 'lnt-chapter-marker-patterns';

function loadActivePatternKeys() {
  try {
    const saved = JSON.parse(localStorage.getItem(PATTERN_PREF_KEY));
    if (Array.isArray(saved) && saved.length > 0) {
      const validKeys = new Set(HEADER_PATTERN_CATEGORIES.map((c) => c.key));
      return saved.filter((k) => validKeys.has(k));
    }
  } catch {
    // ignore malformed/missing localStorage value, fall through to default
  }
  return [...DEFAULT_ACTIVE_PATTERN_KEYS];
}

function saveActivePatternKeys(keys) {
  try {
    localStorage.setItem(PATTERN_PREF_KEY, JSON.stringify(keys));
  } catch {
    // localStorage unavailable (e.g. private mode) - preference just won't persist
  }
}

export async function renderImportView(container, { onProjectReady }) {
  let activePatternKeys = loadActivePatternKeys();
  const existingProjects = await db.allProjects();

  container.innerHTML = `
    ${existingProjects.length > 0 ? `
      <section class="panel">
        <h2>Your projects</h2>
        <ul class="chapter-list">
          ${existingProjects.map((p) => `
            <li>
              <span>${escapeAttr(p.title)}${p.author ? ` <span class="muted">by ${escapeAttr(p.author)}</span>` : ''}</span>
              <button type="button" class="open-project-btn" data-id="${p.id}">Open</button>
            </li>`).join('')}
        </ul>
      </section>
    ` : ''}
    <section class="panel">
      <h2>Import a project file</h2>
      <label>Project JSON (previously exported from Settings &rarr; Export project) <input type="file" id="import-project-file" accept=".json" /></label>
      <span id="import-status" class="muted"></span>
    </section>
    <section class="panel">
      <h2>${existingProjects.length > 0 ? 'Or start a new project' : '1. Import source text'}</h2>
      <label>Project title <input type="text" id="proj-title" placeholder="My Light Novel" /></label>
      <label>Author <input type="text" id="proj-author" placeholder="(optional)" /></label>
      <label>Raw .txt file <input type="file" id="proj-file" accept=".txt" /></label>
      <fieldset id="marker-patterns">
        <legend>Chapter marker patterns</legend>
        ${HEADER_PATTERN_CATEGORIES.map((c) => `
          <label class="pattern-checkbox">
            <input type="checkbox" data-key="${c.key}" ${activePatternKeys.includes(c.key) ? 'checked' : ''} />
            ${escapeAttr(c.label)}
          </label>`).join('')}
      </fieldset>
      <div id="chapter-preview"></div>
      <button id="commit-import" class="btn-primary" disabled>Create project from these chapters</button>
    </section>
  `;

  const fileInput = container.querySelector('#proj-file');
  const preview = container.querySelector('#chapter-preview');
  const commitBtn = container.querySelector('#commit-import');
  const patternCheckboxes = container.querySelectorAll('#marker-patterns input[type="checkbox"]');
  let detectedChapters = [];
  let rawText = '';

  container.querySelectorAll('.open-project-btn').forEach((btn) => {
    btn.addEventListener('click', () => onProjectReady(btn.dataset.id));
  });

  const importStatusEl = container.querySelector('#import-status');
  container.querySelector('#import-project-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      importStatusEl.textContent = `That doesn't look like a valid project file (bad JSON: ${err.message}).`;
      e.target.value = '';
      return;
    }
    try {
      const newProjectId = await importProject(data);
      onProjectReady(newProjectId);
    } catch (err) {
      importStatusEl.textContent = `Couldn't import that file: ${err.message}`;
      e.target.value = '';
    }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    rawText = await file.text();
    detectedChapters = splitIntoChapters(rawText, activePatternKeys);
    renderPreview();
  });

  patternCheckboxes.forEach((cb) => {
    cb.addEventListener('change', () => {
      activePatternKeys = Array.from(patternCheckboxes).filter((c) => c.checked).map((c) => c.dataset.key);
      saveActivePatternKeys(activePatternKeys);
      if (rawText) {
        detectedChapters = splitIntoChapters(rawText, activePatternKeys);
        renderPreview();
      }
    });
  });

  function scaleEstimate() {
    if (detectedChapters.length === 0) return '';
    const settings = defaultSettings();
    const totalChars = detectedChapters.reduce((sum, c) => sum + c.text.length, 0);
    const totalTokens = detectedChapters.reduce((sum, c) => sum + estimateTokens(c.text), 0);
    const extractionBatches = planExtractionBatches(detectedChapters, settings).length;
    return `<p class="muted">~${totalChars.toLocaleString()} characters, ~${formatTokenCount(totalTokens)} tokens total. ` +
      `At default settings (${formatTokenCount(settings.contextBudget)} context budget), extraction alone would take ` +
      `roughly ${extractionBatches} Ollama call(s) - translation will be similar. Adjust context budget/batch fill in ` +
      `Settings after creating the project if this looks off.</p>`;
  }

  function renderPreview() {
    preview.innerHTML = `
      <p>${detectedChapters.length} chapter(s) detected. Adjust below if boundaries look wrong, then commit.</p>
      ${scaleEstimate()}
      <button id="use-fixed-split" type="button">Use fixed-size chunks instead</button>
      <ul class="chapter-list">
        ${detectedChapters.map((c, i) => `
          <li>
            <input type="text" data-idx="${i}" class="chapter-title-input" value="${escapeAttr(c.title)}" />
            <span class="muted">${c.text.length} chars</span>
          </li>`).join('')}
      </ul>
    `;
    commitBtn.disabled = detectedChapters.length === 0;

    preview.querySelector('#use-fixed-split').addEventListener('click', () => {
      detectedChapters = splitByLineCount(rawText, 300);
      renderPreview();
    });

    preview.querySelectorAll('.chapter-title-input').forEach((input) => {
      input.addEventListener('input', () => {
        detectedChapters[Number(input.dataset.idx)].title = input.value;
      });
    });
  }

  commitBtn.addEventListener('click', async () => {
    const title = container.querySelector('#proj-title').value.trim() || 'Untitled Novel';
    const author = container.querySelector('#proj-author').value.trim();
    const projectId = newId();
    await db.put('projects', { id: projectId, title, author, createdAt: new Date().toISOString() });
    for (const [i, ch] of detectedChapters.entries()) {
      await db.put('chapters', {
        id: newId(),
        projectId,
        index: i,
        title: ch.title,
        text: ch.text,
        translatedText: '',
        status: 'untranslated',
      });
    }
    onProjectReady(projectId);
  });
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}
