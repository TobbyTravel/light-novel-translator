// Rolling-average ETA estimator for batch-based runs (extraction/translation
// loops). Deliberately simple - average time per completed batch so far,
// projected across whatever's left - good enough once 2+ batches have
// finished; before that there's nothing to base an estimate on yet.
export function createEtaTracker() {
  const startedAt = Date.now();

  return {
    // completed/remaining are batch counts as of "now" - the caller passes
    // how many batches have actually finished so far (not the current
    // batch's index), since ETA before any batch has finished is meaningless.
    estimate(completed, remaining) {
      if (completed <= 0 || remaining <= 0) return '';
      const avgMs = (Date.now() - startedAt) / completed;
      return formatDuration(avgMs * remaining);
    },
  };
}

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 10) return '';
  if (totalSec < 60) return `~${totalSec}s remaining`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `~${min}m remaining`;
  const hr = Math.floor(min / 60);
  return `~${hr}h ${min % 60}m remaining`;
}
