// Derives each wizard step's status purely from existing data - no new
// IndexedDB fields, no schema changes. Recomputed on demand (view entry,
// after actions), never polled.
import { db } from '../../storage.js';
import { getJob } from '../../jobs.js';
import { detectDuplicates } from '../../extraction.js';

// `precomputed.duplicates`, if given, is a detectDuplicates() result the
// caller already fetched for its own purposes (e.g. duplicates-step.js
// right after a merge) - reused here instead of scanning again.
export async function computeStepStatuses(projectId, precomputed = {}) {
  const [job, chapters, duplicates, synthesis] = await Promise.all([
    getJob(projectId),
    db.allByProject('chapters', projectId),
    precomputed.duplicates ?? detectDuplicates(projectId),
    db.get('synthesis', projectId),
  ]);

  const extractionJob = job && job.kind === 'extraction' ? job : null;
  const hasExtraction = chapters.some((c) => c.extractionRawResponse);
  const flaggedCount = chapters.filter((c) => c.refusalFlags?.extraction).length;

  let extract;
  if (extractionJob?.status === 'interrupted') {
    extract = { status: 'needs-attention', detail: 'Interrupted - resume available' };
  } else if (extractionJob?.status === 'running') {
    extract = { status: 'in-progress', detail: `Batch ${extractionJob.batchIndex}/${extractionJob.totalBatches}` };
  } else if (flaggedCount > 0) {
    extract = { status: 'needs-attention', detail: `${flaggedCount} chapter(s) flagged` };
  } else if (hasExtraction) {
    extract = { status: 'done', detail: `${chapters.length} chapter(s) processed` };
  } else {
    extract = { status: 'not-started', detail: 'Not run yet' };
  }

  const dupCount = Object.values(duplicates).reduce((n, pairs) => n + pairs.length, 0);
  let duplicatesStatus;
  if (!hasExtraction) duplicatesStatus = { status: 'not-started', detail: 'Run extraction first' };
  else if (dupCount > 0) duplicatesStatus = { status: 'needs-attention', detail: `${dupCount} possible duplicate(s)` };
  else duplicatesStatus = { status: 'done', detail: 'No duplicates found' };

  // standardize.js has no durable job record or "standardized" marker field
  // (applyStandardNameProposal just overwrites englishName/englishRendering
  // directly) - status here is intentionally session-local, not derived.
  const standardize = { status: 'not-started', detail: hasExtraction ? 'Run anytime' : 'Run extraction first' };

  let synthesize;
  if (synthesis) synthesize = { status: 'done', detail: `Generated ${new Date(synthesis.generatedAt).toLocaleDateString()}` };
  else if (hasExtraction) synthesize = { status: 'not-started', detail: 'Not generated yet' };
  else synthesize = { status: 'not-started', detail: 'Run extraction first' };

  const review = { status: 'done', detail: `${chapters.length} chapter(s)` };

  return { extract, duplicates: duplicatesStatus, standardize, synthesize, review };
}
