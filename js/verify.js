// Programmatic grounding check: does a claimed evidence quote actually
// appear in the source chunk it was supposedly extracted from? This catches
// fabricated bible entries that slip past prompt-level anti-hallucination
// instructions, without relying on the model to police itself.

function normalize(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

export function verifyQuote(quote, sourceText) {
  const q = normalize(quote);
  if (!q) return false;
  return normalize(sourceText).includes(q);
}

// A simple, dependency-free similarity check used to flag possible
// duplicate entities (e.g. a name spelled slightly differently in a later
// chunk) for the user to manually review/merge - never auto-merged.
export function looksLikeDuplicate(a, b) {
  const na = normalize(a).toLowerCase();
  const nb = normalize(b).toLowerCase();
  if (!na || !nb || na === nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  return levenshtein(na, nb) <= Math.max(1, Math.floor(Math.min(na.length, nb.length) * 0.2));
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}
