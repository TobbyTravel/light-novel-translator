import { estimateTokens } from './tokens.js';
import { db } from './storage.js';

// Common refusal/moralizing boilerplate that shouldn't appear in a
// translation or extraction result given the prompts explicitly instruct
// against censorship. Matched case-insensitively as substrings.
const REFUSAL_PHRASES = [
  "i cannot assist",
  "i can't assist",
  "i cannot help with",
  "i can't help with",
  "i'm not able to",
  "i am not able to",
  "i won't be able to",
  "i will not be able to",
  "i must decline",
  "i have to decline",
  "i cannot provide",
  "i can't provide",
  "i cannot translate",
  "i can't translate",
  "i cannot generate",
  "i can't generate",
  "as an ai language model",
  "as an ai, i",
  "goes against",
  "against my guidelines",
  "content policy",
  "i'm sorry, but i",
  "i am sorry, but i",
  "i'm unable to",
  "i am unable to",
  "not appropriate for me to",
  "i don't feel comfortable",
  "i do not feel comfortable",
];

// Below this fraction of the source's estimated token length, a
// translation/extraction result is almost certainly truncated or refused
// rather than a genuinely terse rendering.
const MIN_LENGTH_RATIO = 0.2;

// Exported separately from detectRefusal so js/ollama.js can run just the
// phrase check against partial, still-streaming text (the length-ratio
// check below only makes sense once generation is complete).
export function findRefusalPhrases(outputText) {
  const lower = (outputText || '').toLowerCase();
  return REFUSAL_PHRASES.filter((phrase) => lower.includes(phrase));
}

// Pure, local, no LLM calls - runs against already-stored text so a
// crosscheck pass never needs Ollama connectivity.
export function detectRefusal({ sourceText, outputText }) {
  const reasons = [];

  const matches = findRefusalPhrases(outputText || '');
  for (const phrase of matches) {
    reasons.push(`Matched refusal phrase: "${phrase}"`);
  }

  const sourceTokens = estimateTokens(sourceText);
  const outputTokens = estimateTokens(outputText);
  if (sourceTokens > 0) {
    const ratio = outputTokens / sourceTokens;
    if (ratio < MIN_LENGTH_RATIO) {
      reasons.push(`Output is only ${Math.round(ratio * 100)}% of the source's estimated length (expected at least ${Math.round(MIN_LENGTH_RATIO * 100)}%)`);
    }
  }

  return { flagged: reasons.length > 0, reasons };
}

// Runs detectRefusal against one chapter's output and persists the
// flag/attempt-history fields - the single unit of work shared by the
// manual crosscheck pass (js/crosscheck.js, js/ui/refusal-panel.js) and
// automatic, as-each-call-completes flagging (js/translation.js,
// js/extraction.js), so both paths write the exact same field shapes.
export async function flagChapter(chapter, kind, outputText) {
  if (!outputText) return chapter;
  const { flagged, reasons } = detectRefusal({ sourceText: chapter.text, outputText });
  const refusalFlags = { ...(chapter.refusalFlags || {}) };
  const refusalAttempts = { ...(chapter.refusalAttempts || {}) };

  refusalFlags[kind] = flagged ? { reasons, detectedAt: new Date().toISOString() } : null;
  if (flagged && !(refusalAttempts[kind]?.length)) {
    // First time this chapter is flagged for this kind - record the
    // existing output as attempt #1 so history is never lost.
    refusalAttempts[kind] = [{
      model: chapter[kind === 'translation' ? 'translationModel' : 'extractionModel'] || '(primary model)',
      output: outputText,
      flagged: true,
      reasons,
      attemptedAt: new Date().toISOString(),
    }];
  }

  const updated = { ...chapter, refusalFlags, refusalAttempts };
  await db.put('chapters', updated);
  return updated;
}
