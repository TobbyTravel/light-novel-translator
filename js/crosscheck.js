import { db } from './storage.js';
import { detectRefusal, flagChapter } from './refusal.js';
import { translateBatch } from './translation.js';
import { retryExtractionChapter } from './extraction.js';

export { flagChapter };

// Both crosscheck passes are pure local scans over already-stored text -
// no Ollama connectivity required. They read the relevant field for each
// kind, run detectRefusal, and persist flags/attempt-history on the
// chapter record without touching anything else.

async function scanChapters(projectId, kind, getOutputText) {
  const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
  let flaggedCount = 0;
  for (const chapter of chapters) {
    const outputText = getOutputText(chapter);
    if (!outputText) continue;
    const updated = await flagChapter(chapter, kind, outputText);
    if (updated.refusalFlags?.[kind]) flaggedCount++;
  }
  return flaggedCount;
}

export async function runTranslationCrosscheck({ projectId }) {
  return scanChapters(projectId, 'translation', (c) => c.translatedText);
}

export async function runExtractionCrosscheck({ projectId }) {
  return scanChapters(projectId, 'extraction', (c) => c.extractionRawResponse);
}

// Tries each model in settings.fallbackModels, in order, for a single
// flagged chapter, until one attempt isn't flagged. If every model is
// exhausted and still flagged, the LAST attempt's output is kept and the
// chapter stays flagged for manual review - never silently discarded.
export async function retryWithFallbackChain({ projectId, chapter, settings, kind, onAttempt }) {
  const models = settings.fallbackModels || [];
  if (models.length === 0) {
    throw new Error('No fallback models configured in Settings.');
  }

  let current = chapter;
  const attempts = [...(current.refusalAttempts?.[kind] || [])];

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const attemptSettings = { ...settings, model };
    onAttempt?.({ index: i, total: models.length, model });

    let outputText;
    let flagged = true;
    let reasons = [];
    try {
      if (kind === 'translation') {
        outputText = await runSingleTranslationAttempt({ projectId, chapter: current, settings: attemptSettings });
      } else {
        outputText = await retryExtractionChapter({ projectId, chapter: current, settings: attemptSettings });
      }
      ({ flagged, reasons } = detectRefusal({ sourceText: current.text, outputText }));
    } catch (err) {
      outputText = `[Error calling model "${model}": ${err.message}]`;
      reasons = [err.message];
    }

    attempts.push({ model, output: outputText, flagged, reasons, attemptedAt: new Date().toISOString() });
    current = await db.get('chapters', current.id);

    const refusalFlags = { ...(current.refusalFlags || {}), [kind]: flagged ? { reasons, detectedAt: new Date().toISOString() } : null };
    const refusalAttempts = { ...(current.refusalAttempts || {}), [kind]: attempts };
    current = { ...current, refusalFlags, refusalAttempts };
    await db.put('chapters', current);

    if (!flagged) break;
  }

  return current;
}

// translation.js's translateBatch writes directly to the chapters store;
// this wrapper re-reads the fresh chapter record afterward so callers get
// the actual persisted translatedText back as plain output text.
async function runSingleTranslationAttempt({ projectId, chapter, settings }) {
  const { translationSystemPrompt } = await import('./prompts.js');
  const { loadBibleAsPlainObject } = await import('./extraction.js');
  const bible = await loadBibleAsPlainObject(projectId);
  const system = translationSystemPrompt({
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    grouped: false,
  });
  await translateBatch({ batch: [chapter], bible, system, settings, batchIndex: 0 });
  const updated = await db.get('chapters', chapter.id);
  return updated.translatedText;
}

// Builds an exportable record of every flagged chapter (current or
// historically resolved via retry) for the user's own review / to raise
// with the author or model maker - full raw output and attempt history
// included, not just a summary.
export async function exportRefusalReport(projectId) {
  const chapters = (await db.allByProject('chapters', projectId)).sort((a, b) => a.index - b.index);
  const entries = [];
  for (const chapter of chapters) {
    for (const kind of ['translation', 'extraction']) {
      const attempts = chapter.refusalAttempts?.[kind];
      if (!attempts || attempts.length === 0) continue;
      const flag = chapter.refusalFlags?.[kind];
      const last = attempts[attempts.length - 1];
      entries.push({
        chapterTitle: chapter.title,
        chapterIndex: chapter.index,
        kind,
        currentlyFlagged: !!flag,
        reasons: flag?.reasons || last.reasons,
        model: last.model,
        fullOutput: last.output,
        sourceExcerpt: (chapter.text || '').slice(0, 400),
        allAttempts: attempts,
      });
    }
  }
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    entries,
  };
}
