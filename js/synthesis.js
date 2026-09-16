import { chat, extractJson } from './ollama.js';
import { synthesisSystemPrompt, synthesisUserPrompt, synthesisReducePrompt } from './prompts.js';
import { db } from './storage.js';
import { estimateCallTokens } from './tokens.js';
import { packIntoBatches } from './batching.js';

const RESERVED_FOR_OUTPUT_TOKENS = 1500;

function orderedTimeline(entries) {
  return [...entries].sort((a, b) => (a.chapterIndex ?? 0) - (b.chapterIndex ?? 0))
    .map(({ chapterIndex, chapterTitle, summary, keyEvents }) => ({ chapterIndex, chapterTitle, summary, keyEvents }));
}

// Splits timeline entries into batches that each fit under the budget,
// leaving headroom for the system prompt and the model's own output.
function batchEntries(entries, system, budget) {
  return packIntoBatches(
    entries,
    (candidate) => estimateCallTokens({ system, prompt: synthesisUserPrompt({ timelineEntries: candidate }) }),
    budget - RESERVED_FOR_OUTPUT_TOKENS
  );
}

// Estimates whether synthesis will run as one call or a map/reduce over
// several, without actually calling Ollama - used by the UI to warn the
// user before they click "generate."
export function planSynthesisRun({ timelineEntries, settings }) {
  const system = synthesisSystemPrompt({ sourceLanguage: settings.sourceLanguage });
  const entries = orderedTimeline(timelineEntries);
  const singleCallTokens = estimateCallTokens({ system, prompt: synthesisUserPrompt({ timelineEntries: entries }) });
  if (singleCallTokens <= settings.contextBudget - RESERVED_FOR_OUTPUT_TOKENS) {
    return { mode: 'single', calls: 1, estimatedTokens: singleCallTokens };
  }
  const batches = batchEntries(entries, system, settings.contextBudget);
  return { mode: 'map-reduce', calls: batches.length + 1, batchCount: batches.length, estimatedTokens: singleCallTokens };
}

async function callSynthesis({ settings, system, prompt, signal }) {
  const { text } = await chat({ host: settings.ollamaHost, model: settings.model, system, prompt, signal });
  return extractJson(text);
}

// Builds a whole-novel synthesis (synopsis, character arcs, tone notes,
// foreshadowing) from the per-chapter `timeline` summaries the extraction
// pass already produced - never by re-reading raw chapter text, keeping
// this cheap even for a very long novel. For a novel whose summaries don't
// fit in one call, runs an independent per-batch pass followed by ONE
// reduce call - bounded at two rounds, not an open-ended accumulation.
export async function runSynthesis({ projectId, settings, onProgress, signal }) {
  const timeline = await db.allByProject('timeline', projectId);
  if (timeline.length === 0) {
    throw new Error('No timeline entries yet - run the extraction pass first.');
  }
  const entries = orderedTimeline(timeline);
  const system = synthesisSystemPrompt({ sourceLanguage: settings.sourceLanguage });
  const plan = planSynthesisRun({ timelineEntries: timeline, settings });

  let result;
  if (plan.mode === 'single') {
    onProgress?.({ stage: 'single', batch: 1, totalBatches: 1 });
    result = await callSynthesis({ settings, system, prompt: synthesisUserPrompt({ timelineEntries: entries }), signal });
  } else {
    const batches = batchEntries(entries, system, settings.contextBudget);
    const partials = [];
    for (let i = 0; i < batches.length; i++) {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      onProgress?.({ stage: 'map', batch: i + 1, totalBatches: batches.length });
      partials.push(await callSynthesis({ settings, system, prompt: synthesisUserPrompt({ timelineEntries: batches[i] }), signal }));
    }
    onProgress?.({ stage: 'reduce', batch: batches.length + 1, totalBatches: batches.length + 1 });
    try {
      result = await callSynthesis({ settings, system, prompt: synthesisReducePrompt({ partialSyntheses: partials }), signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Fall back to a concatenation of partial synopses rather than losing
      // the work already done if the reduce call itself fails.
      result = {
        synopsis: partials.map((p, i) => `[Part ${i + 1}] ${p.synopsis ?? ''}`).join('\n\n'),
        characterArcs: partials.flatMap((p) => p.characterArcs ?? []),
        toneNotes: partials.map((p) => p.toneNotes).filter(Boolean).join(' '),
        foreshadowing: partials.flatMap((p) => p.foreshadowing ?? []),
      };
    }
  }

  const record = {
    id: projectId,
    projectId,
    synopsis: result.synopsis ?? '',
    characterArcs: result.characterArcs ?? [],
    toneNotes: result.toneNotes ?? '',
    foreshadowing: result.foreshadowing ?? [],
    generatedAt: new Date().toISOString(),
  };
  await db.put('synthesis', record);
  return record;
}
