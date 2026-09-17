import { runAutoPipeline } from '../autorun.js';
import { getJob } from '../jobs.js';
import { createLiveOutputPanel } from './live-output.js';
import { computeStepStatuses } from './bible/step-status.js';
import { renderStepper, BIBLE_STEPS } from './bible/stepper.js';
import { renderExtractStep } from './bible/extract-step.js';
import { renderDuplicatesStep } from './bible/duplicates-step.js';
import { renderStandardizeStep } from './bible/standardize-step.js';
import { renderSynthesizeStep } from './bible/synthesize-step.js';
import { renderReviewStep } from './bible/review-step.js';

const STEP_RENDERERS = {
  extract: renderExtractStep,
  duplicates: renderDuplicatesStep,
  standardize: renderStandardizeStep,
  synthesize: renderSynthesizeStep,
  review: renderReviewStep,
};

// Thin shell: autopilot panel + step indicator + delegates the actual
// content to one of js/ui/bible/*-step.js based on the :step route segment
// (js/app.js). Each step file owns its own DOM/wiring; switching steps is
// a normal hashchange remount, so steps never need to manually refresh
// each other - only the stepper (shared, persistent across steps) needs an
// explicit refresh hook, passed down as `refreshStepper`.
export function renderBibleView(container, { projectId, settings, step }) {
  const activeStep = BIBLE_STEPS.some((s) => s.key === step) ? step : 'extract';

  container.innerHTML = `
    <section class="panel">
      <h2>2. Story bible</h2>
      <div class="panel autorun-box">
        <div class="row">
          <button id="run-all" class="btn-primary">Run all (extraction &rarr; duplicates &rarr; standardize &rarr; synthesis &rarr; translation)</button>
          <button id="stop-all" hidden>Stop</button>
          <span id="autorun-status" class="muted"></span>
        </div>
        <p class="muted">Runs every stage unattended - extraction, duplicate resolution, name standardization, story synthesis, and translation - so it's ready when you get back. Chapter/batch failures are logged and skipped rather than stopping the run. Prefer control? Use the steps below instead.</p>
        <div id="autorun-live-output"></div>
      </div>
      <nav class="bible-stepper" id="bible-stepper"></nav>
      <div id="bible-step-content"></div>
    </section>
  `;

  const stepperEl = container.querySelector('#bible-stepper');
  const stepContentEl = container.querySelector('#bible-step-content');
  const autorunStatusEl = container.querySelector('#autorun-status');
  const runAllBtn = container.querySelector('#run-all');
  const stopAllBtn = container.querySelector('#stop-all');
  const autopilotLiveOutput = createLiveOutputPanel(container.querySelector('#autorun-live-output'));

  async function refreshStepper(precomputed) {
    const statuses = await computeStepStatuses(projectId, precomputed);
    renderStepper(stepperEl, { projectId, activeStep, statuses });
  }

  runAllBtn.addEventListener('click', async () => {
    const existingJob = await getJob(projectId);
    if (existingJob?.status === 'running') {
      alert(`A ${existingJob.kind} job is already running for this project - wait for it to finish or stop it first.`);
      return;
    }
    if (!settings.model) {
      alert('Set an Ollama model name in Settings first.');
      return;
    }
    runAllBtn.disabled = true;
    stopAllBtn.hidden = false;
    const controller = new AbortController();
    stopAllBtn.onclick = () => {
      stopAllBtn.disabled = true;
      stopAllBtn.textContent = 'Stopping...';
      controller.abort();
    };
    const originalTitle = document.title;
    let wakeLock = null;
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      // Best-effort only - not all browsers/contexts support this.
    }

    autorunStatusEl.textContent = 'Starting...';
    autopilotLiveOutput.reset();
    await runAutoPipeline({
      projectId,
      settings,
      signal: controller.signal,
      onToken: (chunk, full) => autopilotLiveOutput.onToken(chunk, full),
      onProgress: (p) => {
        let label;
        if (p.stage === 'done') {
          label = p.aborted
            ? 'Stopped by request. Whatever finished so far is kept - re-run to continue.'
            : p.stageErrors.length > 0
              ? `Done, with ${p.stageErrors.length} stage-level error(s) - check console.`
              : 'Done - extraction, duplicates, standardization, synthesis, and translation all complete.';
        } else if (p.done) {
          label = `${p.stage} complete.`;
        } else if (p.chapter || p.batch) {
          const label2 = p.batch?.length > 1 ? `${p.batch.length} chapters` : (p.batch?.[0]?.title || p.chapter?.title || '');
          label = `${p.stage}: ${label2 ? `processing ${label2}` : 'running'}`;
        } else if (p.stage === 'synthesis' && p.batch) {
          label = `synthesis: batch ${p.batch}/${p.totalBatches}`;
        } else {
          label = `${p.stage}: starting...`;
        }
        autorunStatusEl.textContent = label;
        document.title = `[${p.stage}] ${originalTitle}`;
      },
    });

    document.title = originalTitle;
    wakeLock?.release?.().catch(() => {});
    runAllBtn.disabled = false;
    stopAllBtn.hidden = true;
    stopAllBtn.disabled = false;
    stopAllBtn.textContent = 'Stop';
    await refreshStepper();
    // Autopilot can touch data behind whichever step happens to be showing
    // (extraction/duplicates/standardize/synthesis all ran) - re-render it
    // so the visible panel reflects the run instead of staying stale until
    // the user navigates away and back.
    STEP_RENDERERS[activeStep](stepContentEl, { projectId, settings, refreshStepper });
  });

  refreshStepper();
  STEP_RENDERERS[activeStep](stepContentEl, { projectId, settings, refreshStepper });
}
