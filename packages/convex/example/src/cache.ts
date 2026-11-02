import type { ImageResult, Job } from "../shared/types";

const DATABASE = "convex-image-processing";
const STORE = "jobs";
export const MAX_HISTORY = 20;

type CachedResult = Omit<ImageResult, "url"> & { blob: Blob };
type CachedJob = Omit<Job, "results"> & { results: CachedResult[] };

async function openDatabase(sessionToken: string): Promise<IDBDatabase> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken));
  const scope = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`${DATABASE}-${scope}`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open local image history."));
  });
}

async function transact<T>(
  sessionToken: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDatabase(sessionToken);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error ?? request.error ?? new Error("Local image history failed."));
    };
  });
}

export async function listCachedJobs(sessionToken: string): Promise<CachedJob[]> {
  const jobs = await transact<CachedJob[]>(sessionToken, "readonly", (store) => store.getAll());
  return jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_HISTORY);
}

export async function saveCachedJob(job: Job, blobs: Blob[], sessionToken: string): Promise<void> {
  const record: CachedJob = {
    ...job,
    results: job.results.map((result, index) => {
      const { url: _url, ...metadata } = result;
      return { ...metadata, blob: blobs[index] };
    }),
  };
  const db = await openDatabase(sessionToken);
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.put(record);
    const all = store.getAll() as IDBRequest<CachedJob[]>;
    all.onsuccess = () => {
      const excess = all.result.sort((a, b) => b.createdAt - a.createdAt).slice(MAX_HISTORY);
      for (const old of excess) store.delete(old.id);
    };
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error ?? all.error ?? new Error("Could not save local images."));
    };
  });
}

export async function clearCachedJobs(sessionToken: string): Promise<void> {
  await transact<undefined>(sessionToken, "readwrite", (store) => store.clear());
}

export function withObjectUrls(job: CachedJob): Job {
  return {
    ...job,
    results: job.results.map(({ blob, ...result }) => ({
      ...result,
      url: URL.createObjectURL(blob),
    })),
  };
}
