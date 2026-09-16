// Shared prompt builders. Kept language-agnostic - sourceLanguage/targetLanguage
// are always interpolated rather than assumed.

// Extraction is deliberately INDEPENDENT per chunk: the model is never shown
// a running bible to "update," because that let early mistakes get treated
// as established fact and compound across chunks (see js/extraction.js for
// the merge, which now happens in plain code instead of via the model).
export function extractionSystemPrompt({ sourceLanguage, chapterTitles }) {
  const grouped = chapterTitles && chapterTitles.length > 1;
  return `You are a meticulous literary analyst extracting facts from ${grouped ? 'a chunk containing several consecutive chapters' : 'ONE chunk'} of a novel written in ${sourceLanguage}. ` +
    `You have NOT seen any other part of the novel - work ONLY from the text given below.\n\n` +
    (grouped
      ? `The text below contains ${chapterTitles.length} chapters, each preceded by a marker line exactly like ` +
        `"=== CHAPTER: <title> ===". The chapters, in order, are: ${chapterTitles.map((t) => `"${t}"`).join(', ')}.\n\n`
      : '') +
    `Return a single JSON object with this exact shape:\n\n` +
    `{\n` +
    `  "characters": [{ "sourceName": string, "englishName": string, "aliases": string[], "honorifics": string, ` +
    `"speechStyle": string, "role": string, "notes": string, "sourceEvidence": string }],\n` +
    `  "relationships": [{ "characterA": string, "characterB": string, "type": string, "speechRegisterNotes": string, "basis": string }],\n` +
    `  "locations": [{ "sourceName": string, "englishName": string, "description": string, "sourceEvidence": string }],\n` +
    `  "terminology": [{ "sourceTerm": string, "englishRendering": string, "category": string, "notes": string, "sourceEvidence": string }],\n` +
    `  "timelineEntries": [{ "chapterTitle": string, "summary": string, "keyEvents": string[] }]\n` +
    `}\n\n` +
    `Critical rules:\n` +
    `- Only include entities and facts that are EXPLICITLY present in the text below. Do not use outside knowledge, ` +
    `genre conventions, or assumptions about what this kind of story "usually" involves (e.g. do not infer a historical ` +
    `or martial-arts setting just because names sound a certain way - use only what the text actually describes).\n` +
    `- If you are not sure something is stated in the text, OMIT it rather than guess.\n` +
    `- "sourceEvidence" is REQUIRED for every character/location/terminology entry: a short (5-15 word) VERBATIM quote ` +
    `copied exactly from the text below that supports this entry. Do not paraphrase the quote.\n` +
    `- "basis" for relationships is a short free-text note on what in the text shows this relationship (paraphrase is fine).\n` +
    `- "englishName"/"englishRendering" are your PROPOSED renderings for a human editor to approve - pick natural, ` +
    `consistent forms and briefly justify unusual choices in "notes".\n` +
    `- "timelineEntries" MUST have exactly ${grouped ? 'one entry per chapter given above, in the same order, with ' +
      '"chapterTitle" matching the marker exactly' : 'one entry, for this chunk, with "chapterTitle" set to the chunk\'s title'}.\n` +
    `- Respond with ONLY the JSON object, no commentary, no markdown fences.`;
}

export function extractionUserPrompt({ chapterTitle, chapterText, chapters }) {
  if (chapters && chapters.length > 0) {
    if (chapters.length === 1) {
      return `CHUNK ("${chapters[0].title}"):\n${chapters[0].text}`;
    }
    const joined = chapters.map((c) => `=== CHAPTER: ${c.title} ===\n\n${c.text}`).join('\n\n');
    return `CHUNK:\n${joined}`;
  }
  return `CHUNK ("${chapterTitle}"):\n${chapterText}`;
}

export function translationSystemPrompt({ sourceLanguage, targetLanguage, grouped }) {
  return `You are an expert literary translator converting a light novel from ${sourceLanguage} into ${targetLanguage}. ` +
    `You are given a STORY BIBLE (characters, relationships, locations, terminology, prior chapter summaries, and an ` +
    `optional whole-novel "synthesis") as JSON, and the text of ${grouped ? 'several consecutive chapters' : 'ONE chapter'} to translate.\n\n` +
    `Rules:\n` +
    `- Use the approved English names, aliases, and terminology from the bible consistently. Do not invent alternate ` +
    `spellings.\n` +
    `- Use the "relationships" entries to choose the correct speech register/formality between characters (e.g. keep ` +
    `honorifics or drop them consistently with how the bible describes that relationship).\n` +
    `- Render slang, euphemisms, and innuendo the way the bible's "terminology" entries specify, preserving tone and ` +
    `intent rather than translating literally.\n` +
    `- If present, the bible's "synthesis" field describes the overall plot arc, character development, tone, and ` +
    `foreshadowing across the whole novel - use it to keep this chapter's phrasing consistent with how things develop ` +
    `and pay off later, WITHOUT stating future events outright or otherwise spoiling what hasn't happened yet in this chapter.\n` +
    `- Preserve paragraph breaks and dialogue structure from the source.\n` +
    `- Do not censor, sanitize, or add content warnings - translate mature content faithfully, as the user has chosen ` +
    `a model and target audience appropriate for it.\n` +
    (grouped
      ? `- The input contains multiple chapters, each preceded by a marker line exactly like "=== CHAPTER: <title> ===". ` +
        `Reproduce each marker line VERBATIM immediately before that chapter's translation, in the same order, so the ` +
        `chapters can be split back apart automatically.\n`
      : '') +
    `- Respond with ONLY the translated text${grouped ? ' (including the chapter markers)' : ''}, no commentary, no markdown fences.`;
}

export function translationUserPrompt({ bible, chapterTitle, chapterText }) {
  return `STORY BIBLE:\n${JSON.stringify(bible)}\n\n` +
    `TEXT TO TRANSLATE ("${chapterTitle}"):\n${chapterText}`;
}

// Synthesis works from the per-chapter `timeline` summaries the extraction
// pass already produced - NOT by re-reading raw chapter text - so it stays
// cheap even for a very long novel and never reintroduces the raw-text
// context-window problem extraction was fixed to avoid.
export function synthesisSystemPrompt({ sourceLanguage }) {
  return `You are a literary editor building a whole-novel understanding of a novel written in ${sourceLanguage}, ` +
    `to guide a translator. You are given an ordered list of per-chapter summaries (each already grounded in the actual ` +
    `text of its chapter). You have NOT seen the raw chapter text yourself - work ONLY from the summaries given.\n\n` +
    `Return a single JSON object with this exact shape:\n\n` +
    `{\n` +
    `  "synopsis": string,\n` +
    `  "characterArcs": [{ "character": string, "arc": string }],\n` +
    `  "toneNotes": string,\n` +
    `  "foreshadowing": [{ "note": string, "setupChapter": number, "payoffChapter": number }]\n` +
    `}\n\n` +
    `Rules:\n` +
    `- "synopsis" is a 1-3 paragraph overall plot summary based only on the chapter summaries given.\n` +
    `- "characterArcs" covers characters who appear across multiple chapter summaries, describing how they develop.\n` +
    `- "toneNotes" is guidance on genre, register, and style relevant to translation choices (e.g. comedic, serious, ` +
    `formal/informal dialogue).\n` +
    `- "foreshadowing" lists setups and payoffs you can actually observe across the given summaries (e.g. a mystery ` +
    `raised in one chapter's summary and resolved in a later one) - do not invent connections that aren't supported ` +
    `by the summaries.\n` +
    `- Only synthesize from the chapter summaries given below - do not invent plot points, characters, or chapters ` +
    `that weren't in them.\n` +
    `- Respond with ONLY the JSON object, no commentary, no markdown fences.`;
}

export function synthesisUserPrompt({ timelineEntries }) {
  return `CHAPTER SUMMARIES (in order):\n${JSON.stringify(timelineEntries)}`;
}

// Combines multiple partial synopses (produced by running synthesis on
// separate batches of chapters, for a novel too long to summarize in one
// call) into one final synthesis of the same shape - a single reduce step,
// not an open-ended incremental accumulation.
export function synthesisReducePrompt({ partialSyntheses }) {
  return `PARTIAL SYNTHESES, one per consecutive batch of chapters, IN ORDER:\n${JSON.stringify(partialSyntheses)}\n\n` +
    `Combine these into ONE final synthesis of the same JSON shape, covering the whole novel. Merge character arcs ` +
    `for the same character across batches into one entry each. Keep foreshadowing chapter numbers as given.`;
}
