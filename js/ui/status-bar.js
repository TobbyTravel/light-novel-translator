import { db } from '../storage.js';

// Small always-visible widget (same corner-widget pattern as reset-corner.js)
// showing the active/interrupted job for the current project, plus a nod to
// any OTHER project left interrupted - so progress is visible no matter
// which view you're on, and survives navigating away and back.
let pollHandle = null;

const STAGE_VIEW = { extraction: 'bible', synthesis: 'bible', translation: 'translate', autopilot: 'bible' };

export function renderStatusBar(container, { projectId }) {
  if (pollHandle) clearInterval(pollHandle);
  if (!projectId) {
    container.innerHTML = '';
    return;
  }

  async function refresh() {
    const [job, allJobs] = await Promise.all([db.get('jobs', projectId), db.allRecords('jobs')]);
    const otherInterrupted = allJobs.filter((j) => j.projectId !== projectId && j.status === 'interrupted');
    const others = otherInterrupted.length > 0 ? await renderOthers(otherInterrupted) : '';

    if (!job || job.status === 'done' || job.status === 'cancelled') {
      container.innerHTML = others;
      return;
    }

    const total = Math.max(job.totalBatches, 1);
    const view = STAGE_VIEW[job.kind] || 'bible';
    container.innerHTML = `
      <div class="status-bar-row">
        <span><strong>${job.kind}</strong>${job.status === 'interrupted' ? ' - interrupted' : ' - running'} - batch ${job.batchIndex}/${job.totalBatches}</span>
        <progress value="${job.batchIndex}" max="${total}"></progress>
        <span class="muted">in: ${job.tokensIn ?? 0} / out: ${job.tokensOut ?? 0} tokens</span>
        ${job.status === 'interrupted' ? `<a href="#/project/${projectId}/${view}">Resume</a>` : ''}
      </div>
      ${others}
    `;
  }

  async function renderOthers(list) {
    const withTitles = await Promise.all(list.map(async (j) => ({ j, project: await db.get('projects', j.projectId) })));
    return `<div class="status-bar-others muted">Also interrupted: ${withTitles.map(({ j, project }) =>
      `<a href="#/project/${j.projectId}/${STAGE_VIEW[j.kind] || 'bible'}">${project?.title || j.projectId}</a>`
    ).join(', ')}</div>`;
  }

  refresh();
  pollHandle = setInterval(refresh, 1000);
}
