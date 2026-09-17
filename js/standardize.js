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

// Runs the pass for a single store, returning only proposals that actually
// differ from the current englishName/englishRendering - nothing here
// writes to the database.
async function proposeForStore(store, projectId, settings, onToken, signal) {
  const config = STORE_CONFIG[store];
  const records = await db.allByProject(store, projectId);
  if (records.length === 0) return [];

  const system = standardizeNamesSystemPrompt({
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    entityType: store,
  });
  const prompt = standardizeNamesUserPrompt({ items: records.map((r) => toPromptItem(r, config)) });
  const { text } = await chat({ host: settings.ollamaHost, model: settings.model, system, prompt, onToken, signal });
  const parsed = extractJson(text);
  const proposals = parsed?.proposals || [];

  return proposals
    .map((p) => {
      const record = records.find((r) => r[config.keyField] === p.key);
      if (!record) return null;
      const currentEnglish = record[config.targetField] || '';
      const proposedEnglish = (p.englishName || '').trim();
      if (!proposedEnglish || proposedEnglish === currentEnglish) return null;
      return { store, recordId: record.id, key: p.key, currentEnglish, proposedEnglish, reason: p.reason || '' };
    })
    .filter(Boolean);
}

// Runs the pass across characters/locations/terminology in turn, returning
// the full list of proposed changes for the user to review before applying.
export async function runStandardizeNames({ projectId, settings, onToken, onProgress, signal }) {
  const allProposals = [];
  for (let i = 0; i < STANDARDIZABLE_STORES.length; i++) {
    if (signal?.aborted) break;
    const store = STANDARDIZABLE_STORES[i];
    onProgress?.({ store, index: i, total: STANDARDIZABLE_STORES.length });
    const proposals = await proposeForStore(store, projectId, settings, onToken, signal);
    allProposals.push(...proposals);
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
