import { db } from '../storage.js';
import { formatDuration } from '../eta.js';
import { subscribeActivity } from './activity.js';

// Persistent, sticky, route-independent widget (renders into #activity-bar,
// a sibling of #app in index.html, rendered once at startup - never
// recreated by the router) showing, for the current project:
//  - the durable job record's progress/tokens/resume link (DB-polled every
//    second, same as before - this is what survives a page reload), plus a
//    countdown derived from that same persisted record (startedAt vs.
//    batchIndex/totalBatches), so it also survives a reload
//  - the free-text status label and live streaming output pushed by
//    whichever view is currently running a job (js/ui/activity.js) - these
//    are in-memory only by design (never persisted) and clear on reload
let pollHandle = null;
let unsubscribeActivity = null;

const STAGE_VIEW = { extraction: 'bible', synthesis: 'bible', translation: 'translate', autopilot: 'bible' };

export function renderActivityBar(container, { projectId }) {
  if (pollHandle) clearInterval(pollHandle);
  unsubscribeActivity?.();

  if (!projectId) {
    container.innerHTML = '';
    return;
  }

  let activityState = { statusText: '', liveText: '', running: false };
  let lastJob = null;

  function etaFor(job) {
    if (!job || job.status !== 'running' || job.batchIndex <= 0 || job.totalBatches <= 0) return '';
    const completed = job.batchIndex;
    const remaining = job.totalBatches - completed;
    if (remaining <= 0) return '';
    const elapsedMs = Date.now() - new Date(job.startedAt).getTime();
    const avgMs = elapsedMs / completed;
    const remainingLabel = formatDuration(avgMs * remaining);
    return remainingLabel ? ` - ${remainingLabel}` : '';
  }

  function render() {
    const job = lastJob;
    const jobRow = renderJobRow(job);
    const liveRow = renderLiveRow();
    container.innerHTML = jobRow || liveRow ? `${jobRow}${liveRow}` : '';
  }

  function renderJobRow(job) {
    if (!job || job.status === 'done' || job.status === 'cancelled') return '';
    const total = Math.max(job.totalBatches, 1);
    const view = STAGE_VIEW[job.kind] || 'bible';
    return `
      <div class="status-bar-row">
        <span><strong>${job.kind}</strong>${job.status === 'interrupted' ? ' - interrupted' : ' - running'} - batch ${job.batchIndex}/${job.totalBatches}${etaFor(job)}</span>
        <progress value="${job.batchIndex}" max="${total}"></progress>
        <span class="muted">in: ${job.tokensIn ?? 0} / out: ${job.tokensOut ?? 0} tokens</span>
        ${job.status === 'interrupted' ? `<a href="#/project/${projectId}/${view}">Resume</a>` : ''}
      </div>
    `;
  }

  function renderLiveRow() {
    if (!activityState.running && !activityState.liveText) return '';
    // liveText stays empty for the whole run when Settings > "Show live
    // model output" is off (js/ui/activity.js) - skip the (otherwise
    // permanently-empty) details panel in that case, keep just the status line.
    const liveOutputPanel = activityState.liveText ? `
      <details class="live-output"${activityState.running ? ' open' : ''}>
        <summary>Live output</summary>
        <pre id="activity-live-text"></pre>
      </details>
    ` : '';
    return `
      <div class="status-bar-row">
        <span class="muted">${activityState.statusText}</span>
      </div>
      ${liveOutputPanel}
    `;
  }

  async function renderOthers(list) {
    const withTitles = await Promise.all(list.map(async (j) => ({ j, project: await db.get('projects', j.projectId) })));
    return `<div class="status-bar-others muted">Also interrupted: ${withTitles.map(({ j, project }) =>
      `<a href="#/project/${j.projectId}/${STAGE_VIEW[j.kind] || 'bible'}">${project?.title || j.projectId}</a>`
    ).join(', ')}</div>`;
  }

  async function refreshJob() {
    const [job, allJobs] = await Promise.all([db.get('jobs', projectId), db.allRecords('jobs')]);
    const otherInterrupted = allJobs.filter((j) => j.projectId !== projectId && j.status === 'interrupted');
    lastJob = job;
    render();
    if (otherInterrupted.length > 0) {
      container.insertAdjacentHTML('beforeend', await renderOthers(otherInterrupted));
    }
    // The live text goes into innerHTML on every render() call above, so
    // re-set it here rather than losing it to the innerHTML rewrite.
    syncLiveText();
  }

  function syncLiveText() {
    const pre = container.querySelector('#activity-live-text');
    if (pre) {
      pre.textContent = activityState.liveText;
      pre.scrollTop = pre.scrollHeight;
    }
  }

  unsubscribeActivity = subscribeActivity((next) => {
    activityState = next;
    render();
    syncLiveText();
  });

  refreshJob();
  pollHandle = setInterval(refreshJob, 1000);
}
