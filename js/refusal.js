import { estimateTokens } from './tokens.js';

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

function findPhraseMatches(outputText) {
  const lower = outputText.toLowerCase();
  return REFUSAL_PHRASES.filter((phrase) => lower.includes(phrase));
}

// Pure, local, no LLM calls - runs against already-stored text so a
// crosscheck pass never needs Ollama connectivity.
export function detectRefusal({ sourceText, outputText }) {
  const reasons = [];

  const matches = findPhraseMatches(outputText || '');
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
