// "Standardize Names" pass: proposes English renderings for the native-
// language names/terms the extraction pass records (extraction deliberately
// no longer guesses englishName/englishRendering itself - see js/prompts.js
// extractionSystemPrompt - since a per-chunk guess never sees an entity's
// other appearances). This pass gathers ALL accumulated evidence for an
// entity across the whole book and proposes one rendering with full context.
// Re-runnable anytime; always reads current evidence fresh. Results are
// never written directly - see applyStandardName, called only after the
// user reviews a proposal (js/ui/bible-view.js).
import { chat, extractJson } from './ollama.js';
import { standardizeNamesSystemPrompt, standardizeNamesUserPrompt } from './prompts.js';
import { db } from './storage.js';
import { estimateCallTokens, numPredictBudget } from './tokens.js';
import { packIntoBatches } from './batching.js';

const STORE_CONFIG = {
  characters: {
    keyField: 'sourceName',
    targetField: 'englishName',
    extraContext: (r) => ({ aliases: r.aliases, honorifics: r.honorifics }),
  },
  locations: {
    keyField: 'sourceName',
    targetField: 'englishName',
    extraContext: (r) => ({ description: r.description }),
  },
  terminology: {
    keyField: 'sourceTerm',
    targetField: 'englishRendering',
    extraContext: (r) => ({ category: r.category }),
  },
};

export const STANDARDIZABLE_STORES = Object.keys(STORE_CONFIG);

function toPromptItem(record, config) {
  return {
    key: record[config.keyField],
    currentEnglish: record[config.targetField] || null,
    ...config.extraContext(record),
    evidence: (record.evidence || []).map((e) => e.quote).filter(Boolean),
  };
}

// Splits a store's records into batches that each fit under the configured
// fill target, same policy as extraction/translation batching (js/extraction.js,
// js/translation.js) - unlike those, this pass has no per-chapter natural
// unit, so without batching a large project (hundreds of characters/locations/
// terms, each with accumulated evidence) becomes ONE call asking the model to
// emit one giant, internally-consistent JSON array. Local/quantized models
// reliably fail at that scale - either giving up early or trailing off before
// finishing the JSON - which surfaced as a hard-to-diagnose JSON-parse error.
function batchRecords(records, config, system, settings) {
  const targetBudget = settings.contextBudget * (settings.batchFillTarget / 100);
  return packIntoBatches(
    records,
    (batch) => estimateCallTokens({ system, prompt: standardizeNamesUserPrompt({ items: batch.map((r) => toPromptItem(r, config)) }) }),
    targetBudget
  );
}

// Runs the pass for a single store, returning only proposals that actually
// differ from the current englishName/englishRendering - nothing here
// writes to the database. A batch that comes back refused or unparseable is
// skipped (not thrown) so proposals already gathered from earlier batches/
// stores survive - mirrors js/extraction.js's refusedEarly handling.
async function proposeForStore(store, projectId, settings, onToken, onBatchProgress, signal) {
  const config = STORE_CONFIG[store];
  const records = await db.allByProject(store, projectId);
  if (records.length === 0) return [];

  const system = standardizeNamesSystemPrompt({
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    entityType: store,
  });
  const batches = batchRecords(records, config, system, settings);
  const proposals = [];

  for (let i = 0; i < batches.length; i++) {
    if (signal?.aborted) break;
    const batch = batches[i];
    onBatchProgress?.({ batchIndex: i, batchTotal: batches.length });

    const prompt = standardizeNamesUserPrompt({ items: batch.map((r) => toPromptItem(r, config)) });
    const { text, refusedEarly } = await chat({ host: settings.ollamaHost, model: settings.model, system, prompt, onToken, numPredict: numPredictBudget({ system, prompt, contextBudget: settings.contextBudget }), signal });
    if (refusedEarly) {
      // chat() already cancelled the stream on a refusal-phrase match - text
      // is partial and won't parse as JSON, so don't bother trying.
      continue;
    }
    let parsed;
    try {
      parsed = extractJson(text);
    } catch (err) {
      // Malformed/incomplete JSON from this batch - skip it rather than
      // losing every proposal already gathered from earlier batches/stores.
      continue;
    }

    for (const p of parsed?.proposals || []) {
      const record = batch.find((r) => r[config.keyField] === p.key);
      if (!record) continue;
      const currentEnglish = record[config.targetField] || '';
      const proposedEnglish = (p.englishName || '').trim();
      if (!proposedEnglish || proposedEnglish === currentEnglish) continue;
      proposals.push({ store, recordId: record.id, key: p.key, currentEnglish, proposedEnglish, reason: p.reason || '' });
    }
  }

  return proposals;
}

// Runs the pass across characters/locations/terminology in turn, returning
// the full list of proposed changes for the user to review before applying.
export async function runStandardizeNames({ projectId, settings, onToken, onProgress, signal }) {
  const allProposals = [];
  for (let i = 0; i < STANDARDIZABLE_STORES.length; i++) {
    if (signal?.aborted) break;
    const store = STANDARDIZABLE_STORES[i];
    onProgress?.({ store, index: i, total: STANDARDIZABLE_STORES.length });
    try {
      const proposals = await proposeForStore(
        store, projectId, settings, onToken,
        (batchInfo) => onProgress?.({ store, index: i, total: STANDARDIZABLE_STORES.length, ...batchInfo }),
        signal
      );
      allProposals.push(...proposals);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // A store-level failure (e.g. a connectivity hiccup) shouldn't discard
      // proposals already gathered from other stores - move on.
    }
  }
  onProgress?.({ done: true, aborted: !!signal?.aborted });
  return allProposals;
}

// Writes one accepted proposal's englishName/englishRendering. Never called
// automatically - only from the user-facing review step.
export async function applyStandardNameProposal(proposal) {
  const config = STORE_CONFIG[proposal.store];
  const record = await db.get(proposal.store, proposal.recordId);
  if (!record) return;
  record[config.targetField] = proposal.proposedEnglish;
  await db.put(proposal.store, record);
}
