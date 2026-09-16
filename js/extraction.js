import { chat, extractJson } from './ollama.js';
import { extractionSystemPrompt, extractionUserPrompt } from './prompts.js';
import { db, newId, ENTITY_STORES } from './storage.js';
import { verifyQuote, looksLikeDuplicate } from './verify.js';
import { estimateCallTokens } from './tokens.js';
import { packIntoBatches } from './batching.js';
import { joinChaptersWithMarkers } from './grouping.js';

// Serializes the current on-disk bible into the plain-object shape the
// translation prompt expects (extraction no longer reads this back - see
// js/prompts.js for why).
export async function loadBibleAsPlainObject(projectId) {
  const [characters, relationships, locations, terminology, timeline] = await Promise.all(
    ENTITY_STORES.map((name) => db.allByProject(name, projectId))
  );
  const synthesis = await db.get('synthesis', projectId);
  return {
    characters: characters.map(stripMeta),
    relationships: relationships.map(stripMeta),
    locations: locations.map(stripMeta),
    terminology: terminology.map(stripMeta),
    timeline: timeline.map(stripMeta).sort((a, b) => (a.chapterIndex ?? 0) - (b.chapterIndex ?? 0)),
    synthesis: synthesis ? { synopsis: synthesis.synopsis, characterArcs: synthesis.characterArcs, toneNotes: synthesis.toneNotes, foreshadowing: synthesis.foreshadowing } : null,
  };
}

function stripMeta({ id, projectId, evidence, verified, ...rest }) {
  return rest;
}

// Finds which chapter in a (possibly multi-chapter) batch a quote actually
// came from, checking each chapter's own text individually - falls back to
// the batch's first chapter (marked unverified) if it matches none.
function attributeQuote(quote, chapters) {
  for (const ch of chapters) {
    if (verifyQuote(quote, ch.text)) {
      return { chapterIndex: ch.index, chapterTitle: ch.title, verified: true };
    }
  }
  return { chapterIndex: chapters[0].index, chapterTitle: chapters[0].title, verified: false };
}

function appendEvidence(existingEvidence, quote, chapters) {
  const evidence = existingEvidence ? [...existingEvidence] : [];
  if (quote) {
    evidence.push({ ...attributeQuote(quote, chapters), quote });
  }
  return evidence;
}

function batchLabel(chapters) {
  return chapters.length === 1 ? chapters[0].title : `${chapters[0].title} .. ${chapters[chapters.length - 1].title}`;
}

// Merging is deterministic, plain-code logic - NOT an LLM call - so an
// earlier hallucination can never "confirm itself" into the running bible.
// Matches are by exact sourceName/sourceTerm; near-duplicates are flagged
// for manual review instead of being auto-merged (see detectDuplicates).
async function mergeCharacters(projectId, characters, chapters) {
  const existing = await db.allByProject('characters', projectId);
  for (const c of characters || []) {
    if (!c.sourceName) continue;
    const match = existing.find((e) => e.sourceName === c.sourceName);
    const record = {
      id: match?.id ?? newId(),
      projectId,
      sourceName: c.sourceName,
      englishName: match?.englishName || c.englishName || '',
      aliases: Array.from(new Set([...(match?.aliases ?? []), ...(c.aliases ?? [])])),
      honorifics: c.honorifics ?? match?.honorifics ?? '',
      speechStyle: c.speechStyle ?? match?.speechStyle ?? '',
      role: c.role ?? match?.role ?? '',
      notes: appendNote(match?.notes, batchLabel(chapters), c.notes),
      evidence: appendEvidence(match?.evidence, c.sourceEvidence, chapters),
      approved: match?.approved ?? false,
    };
    await db.put('characters', record);
    if (!match) existing.push(record);
  }
}

async function mergeRelationships(projectId, relationships, chapters) {
  const existing = await db.allByProject('relationships', projectId);
  for (const r of relationships || []) {
    if (!r.characterA || !r.characterB) continue;
    const match = existing.find(
      (e) =>
        (e.characterA === r.characterA && e.characterB === r.characterB) ||
        (e.characterA === r.characterB && e.characterB === r.characterA)
    );
    const record = {
      id: match?.id ?? newId(),
      projectId,
      characterA: r.characterA,
      characterB: r.characterB,
      type: r.type ?? match?.type ?? '',
      speechRegisterNotes: r.speechRegisterNotes ?? match?.speechRegisterNotes ?? '',
      notes: appendNote(match?.notes, batchLabel(chapters), r.basis),
    };
    await db.put('relationships', record);
    if (!match) existing.push(record);
  }
}

async function mergeLocations(projectId, locations, chapters) {
  const existing = await db.allByProject('locations', projectId);
  for (const l of locations || []) {
    if (!l.sourceName) continue;
    const match = existing.find((e) => e.sourceName === l.sourceName);
    const record = {
      id: match?.id ?? newId(),
      projectId,
      sourceName: l.sourceName,
      englishName: match?.englishName || l.englishName || '',
      description: l.description ?? match?.description ?? '',
      evidence: appendEvidence(match?.evidence, l.sourceEvidence, chapters),
      approved: match?.approved ?? false,
    };
    await db.put('locations', record);
    if (!match) existing.push(record);
  }
}

async function mergeTerminology(projectId, terminology, chapters) {
  const existing = await db.allByProject('terminology', projectId);
  for (const t of terminology || []) {
    if (!t.sourceTerm) continue;
    const match = existing.find((e) => e.sourceTerm === t.sourceTerm);
    const record = {
      id: match?.id ?? newId(),
      projectId,
      sourceTerm: t.sourceTerm,
      englishRendering: match?.englishRendering || t.englishRendering || '',
      category: t.category ?? match?.category ?? '',
      notes: appendNote(match?.notes, batchLabel(chapters), t.notes),
      evidence: appendEvidence(match?.evidence, t.sourceEvidence, chapters),
      approved: match?.approved ?? false,
    };
    await db.put('terminology', record);
    if (!match) existing.push(record);
  }
}

function appendNote(existingNotes, chapterTitle, newNote) {
  if (!newNote) return existingNotes || '';
  const tagged = `[${chapterTitle}] ${newNote}`;
  return existingNotes ? `${existingNotes}\n${tagged}` : tagged;
}

// Zips the model's timelineEntries array positionally against the batch's
// actual chapters. A count mismatch just means some chapters in this batch
// don't get a timeline entry this run (re-runnable later) rather than
// guessing/misattributing which entry belongs to which chapter.
async function addTimelineEntries(projectId, chapters, timelineEntries) {
  const entries = timelineEntries || [];
  const count = Math.min(entries.length, chapters.length);
  for (let i = 0; i < count; i++) {
    const chapter = chapters[i];
    const entry = entries[i];
    await db.put('timeline', {
      id: newId(),
      projectId,
      chapterIndex: chapter.index,
      chapterTitle: chapter.title,
      summary: entry.summary ?? '',
      keyEvents: entry.keyEvents ?? [],
    });
  }
}

// Flags likely-duplicate entities (e.g. a name spelled differently across
// chunks) for the user to manually merge in the Bible view - never merged
// automatically, since automatic reconciliation is what caused the original
// hallucination-compounding bug.
export async function detectDuplicates(projectId) {
  const results = {};
  for (const [store, field] of [['characters', 'sourceName'], ['locations', 'sourceName'], ['terminology', 'sourceTerm']]) {
    const records = await db.allByProject(store, projectId);
    const pairs = [];
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        if (looksLikeDuplicate(records[i][field], records[j][field])) {
          pairs.push([records[i], records[j]]);
        }
      }
    }
    results[store] = pairs;
  }
  return results;
}

export async function mergeDuplicateRecords(store, keepRecord, dropRecord) {
  const merged = {
    ...keepRecord,
    aliases: Array.from(new Set([...(keepRecord.aliases ?? []), ...(dropRecord.aliases ?? []), dropRecord[store === 'terminology' ? 'sourceTerm' : 'sourceName']])),
    notes: [keepRecord.notes, dropRecord.notes].filter(Boolean).join('\n'),
    evidence: [...(keepRecord.evidence ?? []), ...(dropRecord.evidence ?? [])],
  };
  await db.put(store, merged);
  await db.delete(store, dropRecord.id);
  return merged;
}

function extractionBatchEstimate(batch, settings) {
  const chapterTitles = batch.map((c) => c.title);
  const system = extractionSystemPrompt({ sourceLanguage: settings.sourceLanguage, chapterTitles });
  const prompt = extractionUserPrompt({ chapters: batch });
  return estimateCallTokens({ system, prompt });
}

// Auto-batches consecutive chapters to fill settings.batchFillTarget% of the
// context budget, reserving extra headroom (structured JSON output grows
// with entity/quote count as batches get bigger, so a flat reserve would
// under-reserve for large batches).
export function planExtractionBatches(chapters, settings) {
  const targetBudget = settings.contextBudget * (settings.batchFillTarget / 100);
  return packIntoBatches(
    chapters,
    (batch) => extractionBatchEstimate(batch, settings) * 1.4,
    targetBudget
  );
}

// Runs the extraction pass across all chapters of a project, batched into
// as few calls as fit the context budget. Each batch is analyzed
// INDEPENDENTLY (no prior bible state is shown to the model - see
// js/prompts.js); merging into the running bible happens afterward, in
// plain code, in this file.
export async function runExtraction({ projectId, chapters, settings, onProgress, onChapterError }) {
  const batches = planExtractionBatches(chapters, settings);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    onProgress?.({ index: b, total: batches.length, chapter: batch[0], batch, batchIndex: b, totalBatches: batches.length });
    try {
      const chapterTitles = batch.map((c) => c.title);
      const system = extractionSystemPrompt({ sourceLanguage: settings.sourceLanguage, chapterTitles });
      const prompt = extractionUserPrompt({ chapters: batch });
      const estimatedTokens = estimateCallTokens({ system, prompt });
      onProgress?.({ index: b, total: batches.length, chapter: batch[0], batch, estimatedTokens });
      const { text: raw, promptTokens, completionTokens } = await chat({
        host: settings.ollamaHost,
        model: settings.model,
        system,
        prompt,
      });
      const fragment = extractJson(raw);
      await mergeCharacters(projectId, fragment.characters, batch);
      await mergeRelationships(projectId, fragment.relationships, batch);
      await mergeLocations(projectId, fragment.locations, batch);
      await mergeTerminology(projectId, fragment.terminology, batch);
      await addTimelineEntries(projectId, batch, fragment.timelineEntries);
      for (const chapter of batch) {
        await db.put('chapters', {
          ...chapter,
          extractionPromptTokens: promptTokens,
          extractionCompletionTokens: completionTokens,
          extractionBatchSize: batch.length,
          extractionModel: settings.model,
          // Kept purely so a later refusal crosscheck (js/crosscheck.js) has
          // something to scan - extraction itself never reads this back.
          extractionRawResponse: raw,
        });
      }
      onProgress?.({ index: b, total: batches.length, chapter: batch[0], batch, promptTokens, completionTokens });
    } catch (err) {
      for (const chapter of batch) {
        onChapterError?.({ index: b, chapter, error: err });
      }
    }
  }
  onProgress?.({ index: batches.length, total: batches.length, done: true });
}

// Re-runs extraction for a single chapter (e.g. after a refusal-crosscheck
// retry with a fallback model) - always a batch of one, mirroring
// translation.js's retranslateChapter. Merges into the bible exactly like
// the main run (matched by name), so this simply overwrites/extends this
// chapter's contribution rather than needing special-case logic.
export async function retryExtractionChapter({ projectId, chapter, settings }) {
  const chapterTitles = [chapter.title];
  const system = extractionSystemPrompt({ sourceLanguage: settings.sourceLanguage, chapterTitles });
  const prompt = extractionUserPrompt({ chapters: [chapter] });
  const { text: raw, promptTokens, completionTokens } = await chat({
    host: settings.ollamaHost,
    model: settings.model,
    system,
    prompt,
  });
  const fragment = extractJson(raw);
  await mergeCharacters(projectId, fragment.characters, [chapter]);
  await mergeRelationships(projectId, fragment.relationships, [chapter]);
  await mergeLocations(projectId, fragment.locations, [chapter]);
  await mergeTerminology(projectId, fragment.terminology, [chapter]);
  await addTimelineEntries(projectId, [chapter], fragment.timelineEntries);
  await db.put('chapters', {
    ...chapter,
    extractionPromptTokens: promptTokens,
    extractionCompletionTokens: completionTokens,
    extractionBatchSize: 1,
    extractionModel: settings.model,
    extractionRawResponse: raw,
  });
  return raw;
}
