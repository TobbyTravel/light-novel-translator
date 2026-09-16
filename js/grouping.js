// Marker-based joining/splitting used whenever multiple chapters are sent
// to the model in a single call (both extraction and translation batching).

const MARKER_PREFIX = '=== CHAPTER: ';
const MARKER_SUFFIX = ' ===';

export function chapterMarker(title) {
  return `${MARKER_PREFIX}${title}${MARKER_SUFFIX}`;
}

export function joinChaptersWithMarkers(chapters) {
  if (chapters.length === 1) return chapters[0].text;
  return chapters.map((c) => `${chapterMarker(c.title)}\n\n${c.text}`).join('\n\n');
}

// Splits a model response back into per-chapter segments by matching
// "=== CHAPTER: <title> ===" markers against the expected chapter list, in
// order. Returns { ok: false } on any count mismatch rather than guessing.
export function splitByMarkers(text, expectedChapters) {
  if (expectedChapters.length === 1) {
    return { ok: true, segments: [text.trim()] };
  }
  const pattern = /={3}\s*CHAPTER:\s*(.+?)\s*={3}/g;
  const parts = [];
  let match;
  let lastIndex = 0;
  let lastTitle = null;
  while ((match = pattern.exec(text)) !== null) {
    if (lastTitle !== null) {
      parts.push({ title: lastTitle, body: text.slice(lastIndex, match.index).trim() });
    }
    lastTitle = match[1].trim();
    lastIndex = pattern.lastIndex;
  }
  if (lastTitle !== null) {
    parts.push({ title: lastTitle, body: text.slice(lastIndex).trim() });
  }

  if (parts.length !== expectedChapters.length) {
    return { ok: false, segments: [] };
  }
  return { ok: true, segments: parts.map((p) => p.body) };
}
