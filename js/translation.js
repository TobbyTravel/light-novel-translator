import { chat } from './ollama.js';
import { translationSystemPrompt, translationUserPrompt } from './prompts.js';
import { db } from './storage.js';
import { flagChapter } from './refusal.js';
import { loadRawBibleData, buildBibleForChapters } from './extraction.js';
import { estimateCallTokens, numPredictBudget } from './tokens.js';
import { packIntoBatches } from './batching.js';
import { joinChaptersWithMarkers, splitByMarkers } from './grouping.js';
import { startJob, updateJob, finishJob } from './jobs.js';

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
// roughly comparable to, sometimes longer than, source length). rawBible
// (js/extraction.js's loadRawBibleData) is trimmed per candidate batch via
// buildBibleForChapters so the estimate reflects what that batch will
// actually send, not the whole-book bible.
export function planTranslationBatches(chapters, rawBible, settings) {
  if (settings.chapterByChapter) return chapters.map((c) => [c]);
  const targetBudget = settings.contextBudget * (settings.batchFillTarget / 100);
  return packIntoBatches(
    chapters,
    (batch) => {
      const bible = buildBibleForChapters(rawBible, batch);
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
export async function runTranslation({ projectId, chapters, settings, onProgress, onChapterError, onToken, signal, startBatchIndex = 0 }) {
  const rawBible = await loadRawBibleData(projectId);
  const batches = planTranslationBatches(chapters, rawBible, settings);
  if (startBatchIndex > 0) {
    await updateJob(projectId, { status: 'running', batchIndex: startBatchIndex, totalBatches: batches.length });
  } else {
    await startJob(projectId, { kind: 'translation', totalBatches: batches.length, chapterIds: chapters.map((c) => c.id) });
  }

  for (let b = startBatchIndex; b < batches.length; b++) {
    if (signal?.aborted) break;
    const batch = batches[b];
    const bible = buildBibleForChapters(rawBible, batch);
    const grouped = batch.length > 1;
    const system = translationSystemPrompt({
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage,
      grouped,
    });
    await updateJob(projectId, { batchIndex: b });
    const estimatedTokens = estimateCallTokens({ system, prompt: translationPrompt(bible, batch) });
    onProgress?.({ index: b, total: batches.length, chapter: batch[0], batch, estimatedTokens });
    const { aborted, promptTokens, completionTokens } = await translateBatch({ batch, bible, system, settings, onChapterError, onToken, batchIndex: b, signal });
    await updateJob(projectId, { addTokensIn: promptTokens ?? 0, addTokensOut: completionTokens ?? 0 });
    if (aborted) break;
  }
  await finishJob(projectId, signal?.aborted ? 'cancelled' : 'done');
  onProgress?.({ index: batches.length, total: batches.length, done: true, aborted: !!signal?.aborted });
}

// Returns { aborted, promptTokens, completionTokens } - aborted true if this
// batch was cut short by a user-requested abort (so the caller's loop can
// stop immediately without treating it as a failure).
export async function translateBatch({ batch, bible, system, settings, onChapterError, onToken, batchIndex, signal }) {
  try {
    const prompt = translationPrompt(bible, batch);
    const { text, promptTokens, completionTokens } = await chat({
      host: settings.ollamaHost,
      model: settings.model,
      system,
      prompt,
      onToken,
      numPredict: numPredictBudget({ system, prompt, contextBudget: settings.contextBudget }),
      signal,
    });

    if (batch.length === 1) {
      const translatedText = text.trim();
      const record = {
        ...batch[0],
        translatedText,
        status: 'translated',
        promptTokens,
        completionTokens,
        translationBatchSize: 1,
        translationModel: settings.model,
      };
      await db.put('chapters', record);
      // Flag immediately rather than waiting for a manual crosscheck run -
      // catches both a full refusal and one cut short by chat()'s
      // mid-stream early-abort (js/ollama.js), whose partial text still
      // lands here as the chapter's stored output.
      await flagChapter(record, 'translation', translatedText);
      return { aborted: false, promptTokens, completionTokens };
    }

    const { ok, segments } = splitByMarkers(text, batch);
    if (ok) {
      for (let i = 0; i < batch.length; i++) {
        const record = {
          ...batch[i],
          translatedText: segments[i],
          status: 'translated',
          promptTokens,
          completionTokens,
          translationBatchSize: batch.length,
          translationModel: settings.model,
        };
        await db.put('chapters', record);
        await flagChapter(record, 'translation', segments[i]);
      }
    } else {
      // Marker mismatch: keep the raw response rather than losing it, but
      // never guess which part belongs to which chapter. Also flag it -
      // a mismatch is often itself the result of a refusal that never
      // produced the expected per-chapter markers.
      const rawText = text.trim();
      const record = {
        ...batch[0],
        translatedText: rawText,
        status: 'needs-manual-split',
        promptTokens,
        completionTokens,
        translationBatchSize: batch.length,
        translationModel: settings.model,
      };
      await db.put('chapters', record);
      await flagChapter(record, 'translation', rawText);
      for (const chapter of batch.slice(1)) {
        await db.put('chapters', { ...chapter, status: 'failed' });
      }
    }
    return { aborted: false, promptTokens, completionTokens };
  } catch (err) {
    if (err.name === 'AbortError') return { aborted: true };
    for (const chapter of batch) {
      await db.put('chapters', { ...chapter, status: 'failed' });
      onChapterError?.({ index: batchIndex, chapter, error: err });
    }
  }
  return { aborted: false };
}

// Re-translates a single chapter on demand (e.g. after bible corrections) -
// always a batch of one, regardless of the auto-batching fill target, so a
// targeted fix stays scoped to just that chapter.
export async function retranslateChapter({ projectId, chapter, settings }) {
  const rawBible = await loadRawBibleData(projectId);
  const bible = buildBibleForChapters(rawBible, [chapter]);
  const system = translationSystemPrompt({
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    grouped: false,
  });
  await translateBatch({ batch: [chapter], bible, system, settings, batchIndex: 0 });
}
