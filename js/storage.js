// IndexedDB-backed project storage. One DB, one object store per entity type,
// all scoped under a single active project id so multiple novels can coexist.

const DB_NAME = 'lnt-db';
const DB_VERSION = 3;
const STORES = ['projects', 'chapters', 'characters', 'relationships', 'locations', 'terminology', 'timeline', 'synthesis', 'jobs'];
// One record per project, keyed by id = projectId directly - no projectId index needed.
const NO_PROJECT_INDEX = new Set(['projects', 'synthesis', 'jobs']);

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (!NO_PROJECT_INDEX.has(name)) store.createIndex('projectId', 'projectId');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = fn(store);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function newId() {
  return crypto.randomUUID();
}

export const db = {
  async put(storeName, record) {
    await tx(storeName, 'readwrite', (store) => store.put(record));
    return record;
  },

  async putMany(storeName, records) {
    await tx(storeName, 'readwrite', (store) => {
      for (const r of records) store.put(r);
    });
    return records;
  },

  async get(storeName, id) {
    const db = await openDb();
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    return reqToPromise(store.get(id));
  },

  async delete(storeName, id) {
    return tx(storeName, 'readwrite', (store) => store.delete(id));
  },

  async allByProject(storeName, projectId) {
    const db = await openDb();
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    const index = store.index('projectId');
    return reqToPromise(index.getAll(projectId));
  },

  async allProjects() {
    const db = await openDb();
    const store = db.transaction('projects', 'readonly').objectStore('projects');
    return reqToPromise(store.getAll());
  },

  async allRecords(storeName) {
    const db = await openDb();
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    return reqToPromise(store.getAll());
  },

  async clearProject(projectId) {
    for (const name of STORES.filter((s) => s !== 'projects')) {
      if (NO_PROJECT_INDEX.has(name)) {
        await tx(name, 'readwrite', (store) => store.delete(projectId));
        continue;
      }
      const records = await this.allByProject(name, projectId);
      await tx(name, 'readwrite', (store) => {
        for (const r of records) store.delete(r.id);
      });
    }
  },

  async deleteProject(projectId) {
    await this.clearProject(projectId);
    await this.delete('projects', projectId);
  },

  async resetAll() {
    for (const name of STORES) {
      await tx(name, 'readwrite', (store) => store.clear());
    }
  },
};

export const ENTITY_STORES = ['characters', 'relationships', 'locations', 'terminology', 'timeline'];

export function defaultSettings() {
  return {
    ollamaHost: 'http://localhost:11434',
    model: '',
    sourceLanguage: 'Japanese',
    targetLanguage: 'English',
    // Purely a comparison threshold for the token estimate warnings in the
    // Bible/Translate views - not sent to Ollama. Set this to whatever
    // context size you've actually configured in Ollama itself.
    contextBudget: 16384,
    // Percent of contextBudget to target when auto-batching multiple
    // chapters into one call, leaving headroom for the model's own output.
    batchFillTarget: 80,
    // Ordered list of Ollama model names tried, in order, when a chapter is
    // flagged by the refusal crosscheck (js/crosscheck.js) - never sent to
    // Ollama directly, only used to pick which model each retry attempt uses.
    fallbackModels: [],
  };
}

export async function exportProject(projectId) {
  const project = await db.get('projects', projectId);
  const chapters = await db.allByProject('chapters', projectId);
  const bible = {};
  for (const name of ENTITY_STORES) {
    bible[name] = await db.allByProject(name, projectId);
  }
  const synthesis = await db.get('synthesis', projectId);
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    project,
    chapters,
    bible,
    synthesis: synthesis ?? null,
  };
}

export async function importProject(data) {
  if (!data || !data.project) throw new Error('Invalid project file');
  const projectId = newId();
  const project = { ...data.project, id: projectId };
  await db.put('projects', project);
  const remapChapterIds = new Map();
  for (const ch of data.chapters || []) {
    const newChId = newId();
    remapChapterIds.set(ch.id, newChId);
  }
  for (const ch of data.chapters || []) {
    await db.put('chapters', { ...ch, id: remapChapterIds.get(ch.id), projectId });
  }
  for (const name of ENTITY_STORES) {
    for (const rec of (data.bible && data.bible[name]) || []) {
      await db.put(name, { ...rec, id: newId(), projectId });
    }
  }
  if (data.synthesis) {
    await db.put('synthesis', { ...data.synthesis, id: projectId, projectId });
  }
  return projectId;
}
