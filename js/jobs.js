// Durable job-progress records, one per project (keyed by projectId), so a
// long-running extraction/synthesis/translation pass survives a page
// reload or tab close: completed batches are already safely written to
// their own stores as they happen (chapters/bible entries), but without
// this the "is anything running, and how far did it get" indicator was
// purely in-memory and vanished on reload. Nothing here resumes work
// automatically - see markStaleJobsInterrupted, called once at startup.
import { db } from './storage.js';

export async function startJob(projectId, { kind, stage, totalBatches, chapterIds }) {
  const job = {
    id: projectId,
    projectId,
    kind,
    stage: stage ?? kind,
    batchIndex: 0,
    totalBatches: totalBatches ?? 0,
    chapterIds: chapterIds ?? [],
    status: 'running',
    tokensIn: 0,
    tokensOut: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.put('jobs', job);
  return job;
}

export async function updateJob(projectId, patch) {
  const existing = await db.get('jobs', projectId);
  if (!existing) return null;
  const updated = {
    ...existing,
    ...patch,
    tokensIn: existing.tokensIn + (patch.addTokensIn ?? 0),
    tokensOut: existing.tokensOut + (patch.addTokensOut ?? 0),
    updatedAt: new Date().toISOString(),
  };
  delete updated.addTokensIn;
  delete updated.addTokensOut;
  await db.put('jobs', updated);
  return updated;
}

export async function finishJob(projectId, status) {
  return updateJob(projectId, { status });
}

export async function getJob(projectId) {
  return db.get('jobs', projectId);
}

// Called once at app startup. Nothing survives a page reload (no worker,
// no backend), so any job still marked 'running' at this point was cut
// short - flip it to 'interrupted' so the status bar can offer Resume
// rather than showing a run that's actually dead as still in-progress.
export async function markStaleJobsInterrupted() {
  const all = await db.allRecords('jobs');
  const stale = all.filter((j) => j.status === 'running');
  for (const job of stale) {
    await db.put('jobs', { ...job, status: 'interrupted', updatedAt: new Date().toISOString() });
  }
  return stale.map((j) => j.projectId);
}
