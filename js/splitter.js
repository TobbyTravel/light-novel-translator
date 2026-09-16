// Heuristic, language-agnostic chapter detection for raw light novel text.
// Produces a best-effort list of {title, startLine} boundaries; the UI lets
// the user merge/split/rename before committing, so recall matters more
// than precision here.

// Full-width (zenkaku) digits/punctuation are standard in Japanese
// typesetting (１２３, '．', '：', '－') and must be matched alongside their
// ASCII forms, or headers like "１．タイトル" are silently missed.
const DIGIT = '[0-9０-９]';
const SEP = '[.\\-:．：－]';

const HEADER_PATTERNS = [
  /^\s*(chapter|ch\.?|episode|ep\.?|part)\s*[:\-.]?\s*\d+/i,
  /^\s*第\s*[0-9０-９一二三四五六七八九十百千]+\s*[章話话回]/, // CJK "chapter N" markers
  new RegExp(`^\\s*${DIGIT}+\\s*${SEP}\\s*\\S`), // "12. Title" / "１２．Title" / "12 - Title"
  /^\s*[-=*~_]{3,}\s*$/, // decorative separator lines used as breaks
];

export function splitIntoChapters(rawText) {
  const lines = rawText.split(/\r\n|\r|\n/);
  const boundaries = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (HEADER_PATTERNS.some((re) => re.test(trimmed))) {
      boundaries.push({ startLine: idx, title: trimmed.slice(0, 80) });
    }
  });

  // Fallback: if nothing matched (or too few chapters for the text length),
  // split on runs of 2+ blank lines as a weaker heuristic.
  if (boundaries.length < 2) {
    boundaries.length = 0;
    let blankRun = 0;
    lines.forEach((line, idx) => {
      if (line.trim() === '') {
        blankRun++;
      } else {
        if (blankRun >= 2) {
          boundaries.push({ startLine: idx, title: line.trim().slice(0, 80) || `Section at line ${idx + 1}` });
        }
        blankRun = 0;
      }
    });
  }

  if (boundaries.length === 0 || boundaries[0].startLine !== 0) {
    boundaries.unshift({ startLine: 0, title: 'Chapter 1' });
  }

  return boundaries.map((b, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].startLine : lines.length;
    const text = lines.slice(b.startLine, end).join('\n').trim();
    return {
      title: b.title || `Chapter ${i + 1}`,
      startLine: b.startLine,
      endLine: end,
      text,
    };
  }).filter((ch) => ch.text.length > 0);
}

// Fixed-size fallback splitter, used when a user opts out of auto-detection
// or the detected chapters are still too large for a single model call.
export function splitByLineCount(rawText, linesPerChunk = 300) {
  const lines = rawText.split(/\r\n|\r|\n/);
  const chunks = [];
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    const slice = lines.slice(i, i + linesPerChunk);
    chunks.push({
      title: `Lines ${i + 1}-${i + slice.length}`,
      startLine: i,
      endLine: i + slice.length,
      text: slice.join('\n').trim(),
    });
  }
  return chunks.filter((ch) => ch.text.length > 0);
}
