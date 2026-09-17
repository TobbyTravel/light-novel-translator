// Model-agnostic, heuristic token estimator - there's no in-browser tokenizer
// for an arbitrary Ollama model, so this is deliberately approximate and
// should always be labeled as an estimate in the UI (actual counts, when
// available, come from Ollama's own response - see js/ollama.js).
//
// This app never sends num_ctx to Ollama - context size is managed entirely
// on the Ollama side (Modelfile / app settings). Settings.contextBudget here
// is purely a comparison value the user sets to match whatever they've
// actually configured, so estimates/actuals can be checked against it.

function isWideChar(codePoint) {
  // Rough coverage of CJK Unified Ideographs, Hiragana, Katakana, Hangul,
  // and their fullwidth punctuation/digit forms.
  return (
    (codePoint >= 0x3000 && codePoint <= 0x30ff) || // CJK punctuation, Hiragana, Katakana
    (codePoint >= 0x3400 && codePoint <= 0x9fff) || // CJK Unified Ideographs (+ extension A)
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
    (codePoint >= 0xff00 && codePoint <= 0xffef) // Fullwidth/halfwidth forms
  );
}

export function estimateTokens(text) {
  if (!text) return 0;
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (isWideChar(ch.codePointAt(0))) wide++;
    else narrow++;
  }
  // Wide (CJK-ish) characters: roughly 1 token each.
  // Narrow (Latin-ish) characters: roughly 1 token per 4 characters.
  return Math.ceil(wide + narrow / 4);
}

export function estimateCallTokens({ system, prompt }) {
  return estimateTokens(system) + estimateTokens(prompt);
}

// A floor so a call whose prompt already ate most/all of contextBudget
// still gets *some* room to answer, rather than num_predict collapsing to
// zero or negative (which some backends treat as "unlimited" - the exact
// opposite of what a cap is for).
const MIN_NUM_PREDICT = 512;

// Sizes num_predict (js/ollama.js) to the context budget actually left
// over after this call's own prompt, not the whole budget regardless of
// prompt size - a near-full-context batch would otherwise still be told it
// may generate a second full budget's worth of output on top, defeating
// the point of the cap for exactly the large-batch case it exists to
// protect against.
export function numPredictBudget({ system, prompt, contextBudget }) {
  return Math.max(contextBudget - estimateCallTokens({ system, prompt }), MIN_NUM_PREDICT);
}

export function formatTokenCount(n) {
  if (n == null) return '?';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
