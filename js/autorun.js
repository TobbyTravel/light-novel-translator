import { db } from './storage.js';
import { runExtraction } from './extraction.js';
import { runSynthesis } from './synthesis.js';
import { runTranslation } from './translation.js';

// Runs extraction, synthesis, and translation back-to-back so a long book
// can be left unattended. Per-chapter/batch failures already don't throw
// inside each stage (they're reported via onChapterError and the stage
// continues) - this wrapper additionally makes sure a whole STAGE failing
// outright (e.g. synthesis erroring because a prior stage produced nothing)
// doesn't stop later stages from at least attempting to run.
export async function runAutoPipeline({ projectId, settings, onProgress, onToken, signal }) {
  const stageErrors = [];

  if (!signal?.aborted) {
    onProgress?.({ stage: 'extraction' });
    try {
      const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
      await runExtraction({
        projectId,
        chapters,
        settings,
        signal,
        onToken,
        onProgress: (p) => onProgress?.({ stage: 'extraction', ...p }),
        onChapterError: (e) => onProgress?.({ stage: 'extraction', chapterError: e }),
      });
    } catch (err) {
      if (err.name !== 'AbortError') stageErrors.push({ stage: 'extraction', error: err });
    }
  }

  if (!signal?.aborted) {
    onProgress?.({ stage: 'synthesis' });
    try {
      await runSynthesis({
        projectId,
        settings,
        signal,
        onToken,
        onProgress: (p) => onProgress?.({ stage: 'synthesis', ...p }),
      });
    } catch (err) {
      if (err.name !== 'AbortError') stageErrors.push({ stage: 'synthesis', error: err });
    }
  }

  if (!signal?.aborted) {
    onProgress?.({ stage: 'translation' });
    try {
      const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
      await runTranslation({
        projectId,
        chapters,
        settings,
        signal,
        onToken,
        onProgress: (p) => onProgress?.({ stage: 'translation', ...p }),
        onChapterError: (e) => onProgress?.({ stage: 'translation', chapterError: e }),
      });
    } catch (err) {
      if (err.name !== 'AbortError') stageErrors.push({ stage: 'translation', error: err });
    }
  }

  onProgress?.({ stage: 'done', stageErrors, aborted: !!signal?.aborted });
  return { stageErrors };
}
