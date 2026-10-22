import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import type { WorkspaceUnderstanding } from "@infinite/remote";
import { connectionKey, type Connection } from "../../api/client";

const INDEX_KEY = "infinite.understanding.cache.v1.index";
const PREFIX = "infinite.understanding.cache.v1";
const TTL_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_LIMIT = 4;
const CHUNK_CHARS = 220;
const CHUNK_LIMIT = 8;
type Entry = { scope: string; credential: string; workspaceId: string; generation: string; capturedAt: string; chunkCount: number };
type Index = { entries: Entry[] };
let indexWrites: Promise<void> = Promise.resolve();

/** Caches workspace and repository labels only. Briefs, plans, code, and task text never enter the cache. */
export async function saveUnderstandingSummary(connection: Connection, data: WorkspaceUnderstanding): Promise<void> {
  return withIndexLock(() => saveSummary(connection, data));
}

async function saveSummary(connection: Connection, data: WorkspaceUnderstanding): Promise<void> {
  const { scope, credential } = await identities(connection);
  let compact = minimalSummary(data, 12);
  let serialized = JSON.stringify(compact);
  while (Array.from(serialized).length > CHUNK_CHARS * CHUNK_LIMIT && compact.repositories.length > 1) {
    compact = minimalSummary(data, compact.repositories.length - 1);
    serialized = JSON.stringify(compact);
  }
  if (Array.from(serialized).length > CHUNK_CHARS * CHUNK_LIMIT) return;
  const chunks = split(serialized);
  const index = await readIndex();
  const generation = Crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const workspaceHash = (await digest(data.workspace.id)).slice(0, 24);
  const nextEntry: Entry = { scope, credential, workspaceId: data.workspace.id, generation, capturedAt: new Date().toISOString(), chunkCount: chunks.length };
  const chunkKeys = chunks.map((_, i) => chunkKey(workspaceHash, generation, i));
  try {
    for (let i = 0; i < chunks.length; i++) await SecureStore.setItemAsync(chunkKeys[i], chunks[i], { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    const prior = index.entries.filter(entry => !(entry.scope === scope && entry.workspaceId === data.workspace.id));
    // A new credential for this host invalidates every prior offline snapshot on that host.
    const retained = prior.filter(entry => entry.scope !== scope || entry.credential === credential);
    const entries = [nextEntry, ...retained].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt)).slice(0, WORKSPACE_LIMIT);
    await writeIndex({ entries });
    await removeOrphaned(index.entries, entries);
    if (!entries.includes(nextEntry)) await Promise.allSettled(chunkKeys.map(key => SecureStore.deleteItemAsync(key)));
  } catch {
    await Promise.allSettled(chunkKeys.map(key => SecureStore.deleteItemAsync(key)));
  }
}

export async function readUnderstandingSummary(connection: Connection, workspaceId: string): Promise<{ data: WorkspaceUnderstanding; cachedAt: string } | null> {
  const { scope, credential } = await identities(connection);
  const index = await readIndex();
  const entry = index.entries.find(candidate => candidate.scope === scope && candidate.credential === credential && candidate.workspaceId === workspaceId);
  if (!entry) {
    await withIndexLock(async () => {
      const latest = await readIndex();
      const obsolete = latest.entries.filter(candidate => candidate.scope === scope && candidate.credential !== credential);
      if (!obsolete.length) return;
      const entries = latest.entries.filter(candidate => !obsolete.includes(candidate));
      await writeIndex({ entries });
      await removeOrphaned(latest.entries, entries);
    });
    return null;
  }
  const capturedAt = Date.parse(entry.capturedAt);
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > TTL_MS || entry.chunkCount < 1 || entry.chunkCount > CHUNK_LIMIT) { await clearEntry(index, entry); return null; }
  const workspaceHash = (await digest(workspaceId)).slice(0, 24);
  try {
    const chunks = await Promise.all(Array.from({ length: entry.chunkCount }, (_, i) => SecureStore.getItemAsync(chunkKey(workspaceHash, entry.generation, i))));
    if (chunks.some(chunk => chunk === null)) { await clearEntry(index, entry); return null; }
    const data = JSON.parse(chunks.join("")) as WorkspaceUnderstanding;
    if (data.schemaVersion !== 1 || data.workspace.id !== workspaceId || !Array.isArray(data.repositories) || !Array.isArray(data.work)) { await clearEntry(index, entry); return null; }
    return { data, cachedAt: entry.capturedAt };
  } catch {
    await clearEntry(index, entry);
    return null;
  }
}

export async function clearUnderstandingSummary(connection: Connection, workspaceId: string): Promise<void> {
  return withIndexLock(async () => {
  const { scope, credential } = await identities(connection);
  const index = await readIndex();
  const doomed = index.entries.filter(entry => entry.scope === scope && entry.credential === credential && entry.workspaceId === workspaceId);
  const entries = index.entries.filter(entry => !doomed.includes(entry));
  await writeIndex({ entries });
  await removeOrphaned(index.entries, entries);
  });
}

function minimalSummary(data: WorkspaceUnderstanding, repositoryLimit: number): WorkspaceUnderstanding {
  return {
    schemaVersion: 1,
    workspace: data.workspace,
    observedAt: data.observedAt,
    work: [],
    repositories: data.repositories.slice(0, repositoryLimit).map(repo => ({
      id: repo.id, name: repo.name, checkoutIds: repo.checkoutIds, state: repo.state,
      current: [], planned: [], warnings: [], coverage: [],
    })),
    coverage: ["Offline cache keeps workspace and repository labels and state only; source briefs, plans, code, and work descriptions are not stored.", ...(data.repositories.length > repositoryLimit ? [`Showing ${repositoryLimit} of ${data.repositories.length} repositories in the bounded offline overview.`] : [])],
  };
}

async function identities(connection: Connection) {
  const scope = await digest(JSON.stringify([connectionKey(connection), connection.url, connection.relay?.machineId ?? "direct", connection.machineId ?? ""]));
  const credential = await digest(JSON.stringify([connection.token, connection.access?.clientId ?? "", connection.access?.clientSecret ?? ""]));
  return { scope, credential };
}
async function digest(value: string) { return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value); }
function split(value: string) {
  const result: string[] = []; let chunk = "", count = 0;
  for (const character of value) {
    chunk += character; count++;
    if (count === CHUNK_CHARS) { result.push(chunk); chunk = ""; count = 0; }
  }
  if (chunk) result.push(chunk);
  return result;
}
function chunkKey(workspaceHash: string, generation: string, chunk: number) { return `${PREFIX}.${workspaceHash}.${generation}.${chunk}`; }
async function readIndex(): Promise<Index> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY).catch(() => null);
  if (!raw) return { entries: [] };
  try {
    const parsed = JSON.parse(raw) as Index;
    return Array.isArray(parsed.entries) ? { entries: parsed.entries.filter(entry => entry && typeof entry.scope === "string" && typeof entry.credential === "string" && typeof entry.workspaceId === "string" && typeof entry.generation === "string" && typeof entry.capturedAt === "string" && Number.isInteger(entry.chunkCount) && entry.chunkCount > 0 && entry.chunkCount <= CHUNK_LIMIT).slice(0, WORKSPACE_LIMIT) } : { entries: [] };
  } catch { return { entries: [] }; }
}
async function writeIndex(index: Index) {
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(index), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}
async function clearEntry(index: Index, entry: Entry) {
  await withIndexLock(async () => {
    const latest = await readIndex();
    const current = latest.entries.find(candidate => candidate.scope === entry.scope && candidate.credential === entry.credential && candidate.workspaceId === entry.workspaceId && candidate.generation === entry.generation);
    if (!current) return;
    const entries = latest.entries.filter(candidate => candidate !== current);
    await writeIndex({ entries });
    await removeOrphaned(latest.entries, entries);
  });
}
async function removeOrphaned(before: Entry[], after: Entry[]) {
  const retained = new Set(after.map(entry => `${entry.workspaceId}/${entry.generation}`));
  const removed = before.filter(entry => !retained.has(`${entry.workspaceId}/${entry.generation}`));
  await Promise.allSettled(removed.flatMap(entry => Array.from({ length: entry.chunkCount }, async (_, i) => {
    const hash = (await digest(entry.workspaceId)).slice(0, 24);
    await SecureStore.deleteItemAsync(chunkKey(hash, entry.generation, i));
  })));
}
function withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
  const task = indexWrites.then(operation);
  indexWrites = task.then(() => undefined, () => undefined);
  return task;
}
