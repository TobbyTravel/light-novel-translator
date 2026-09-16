import { chat } from './ollama.js';
import { translationSystemPrompt, translationUserPrompt } from './prompts.js';
import { db } from './storage.js';
import { loadBibleAsPlainObject } from './extraction.js';
import { estimateCallTokens } from './tokens.js';
import { packIntoBatches } from './batching.js';
import { joinChaptersWithMarkers, splitByMarkers } from './grouping.js';

function batchLabel(chapters) {
  return chapters.length === 1 ? chapters[0].title : `${chapters[0].title} .. ${chapters[chapters.length - 1].title}`;
}

function translationPrompt(bible, batch) {
  const grouped = batch.length > 1;
  const text = joinChaptersWithMarkers(batch);
  return translationUserPrompt({ bible, chapterTitle: batchLabel(batch), chapterText: text });
}

// Auto-batches consecutive chapters to fill settings.batchFillTarget% of the
// context budget. Reserve is larger than extraction's (translated output is
// roughly comparable to, sometimes longer than, source length).
export function planTranslationBatches(chapters, bible, settings) {
  const targetBudget = settings.contextBudget * (settings.batchFillTarget / 100);
  return packIntoBatches(
    chapters,
    (batch) => {
      const system = translationSystemPrompt({
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage,
        grouped: batch.length > 1,
      });
      return estimateCallTokens({ system, prompt: translationPrompt(bible, batch) }) * 2.2;
    },
    targetBudget
  );
}

// Translates all chapters of a project, auto-batched into as few calls as
// fit the context budget. No per-batch approval gate - failures are marked
// and left individually retryable.
export async function runTranslation({ projectId, chapters, settings, onProgress, onChapterError, signal }) {
  const bible = await loadBibleAsPlainObject(projectId);
  const batches = planTranslationBatches(chapters, bible, settings);

  for (let b = 0; b < batches.length; b++) {
    if (signal?.aborted) break;
    const batch = batches[b];
    const grouped = batch.length > 1;
    const system = translationSystemPrompt({
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage,
      grouped,
    });
    const estimatedTokens = estimateCallTokens({ system, prompt: translationPrompt(bible, batch) });
    onProgress?.({ index: b, total: batches.length, chapter: batch[0], batch, estimatedTokens });
    const aborted = await translateBatch({ batch, bible, system, settings, onChapterError, batchIndex: b, signal });
    if (aborted) break;
  }
  onProgress?.({ index: batches.length, total: batches.length, done: true, aborted: !!signal?.aborted });
}

// Returns true if this batch was cut short by a user-requested abort (so the
// caller's loop can stop immediately without treating it as a failure).
export async function translateBatch({ batch, bible, system, settings, onChapterError, batchIndex, signal }) {
  try {
    const prompt = translationPrompt(bible, batch);
    const { text, promptTokens, completionTokens } = await chat({
      host: settings.ollamaHost,
      model: settings.model,
      system,
      prompt,
      signal,
    });

    if (batch.length === 1) {
      await db.put('chapters', {
        ...batch[0],
        translatedText: text.trim(),
        status: 'translated',
        promptTokens,
        completionTokens,
        translationBatchSize: 1,
        translationModel: settings.model,
      });
      return;
    }

    const { ok, segments } = splitByMarkers(text, batch);
    if (ok) {
      for (let i = 0; i < batch.length; i++) {
        await db.put('chapters', {
          ...batch[i],
          translatedText: segments[i],
          status: 'translated',
          promptTokens,
          completionTokens,
          translationBatchSize: batch.length,
          translationModel: settings.model,
        });
      }
    } else {
      // Marker mismatch: keep the raw response rather than losing it, but
      // never guess which part belongs to which chapter.
      await db.put('chapters', {
        ...batch[0],
        translatedText: text.trim(),
        status: 'needs-manual-split',
        promptTokens,
        completionTokens,
        translationBatchSize: batch.length,
        translationModel: settings.model,
      });
      for (const chapter of batch.slice(1)) {
        await db.put('chapters', { ...chapter, status: 'failed' });
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return true;
    for (const chapter of batch) {
      await db.put('chapters', { ...chapter, status: 'failed' });
      onChapterError?.({ index: batchIndex, chapter, error: err });
    }
  }
  return false;
}

// Re-translates a single chapter on demand (e.g. after bible corrections) -
// always a batch of one, regardless of the auto-batching fill target, so a
// targeted fix stays scoped to just that chapter.
export async function retranslateChapter({ projectId, chapter, settings }) {
  const bible = await loadBibleAsPlainObject(projectId);
  const system = translationSystemPrompt({
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    grouped: false,
  });
  await translateBatch({ batch: [chapter], bible, system, settings, batchIndex: 0 });
}
