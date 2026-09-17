// Pure rendering for the Story Bible step indicator - takes pre-computed
// statuses (see step-status.js) and draws five clickable segments that
// navigate via the existing hash router (js/app.js), so switching steps is
// a normal hashchange remount like every other top-level view.
export const BIBLE_STEPS = [
  { key: 'extract', label: 'Extract' },
  { key: 'duplicates', label: 'Duplicates' },
  { key: 'standardize', label: 'Standardize names' },
  { key: 'synthesize', label: 'Synthesize' },
  { key: 'review', label: 'Review data' },
];

export function renderStepper(container, { projectId, activeStep, statuses }) {
  container.innerHTML = BIBLE_STEPS.map((s) => {
    const st = statuses[s.key] || { status: 'not-started', detail: '' };
    return `
      <a class="bible-step status-${st.status} ${s.key === activeStep ? 'active' : ''}" href="#/project/${projectId}/bible/${s.key}">
        <span class="step-top"><span class="step-dot"></span><span class="step-label">${s.label}</span></span>
        <span class="step-detail muted">${st.detail}</span>
      </a>`;
  }).join('');
}
