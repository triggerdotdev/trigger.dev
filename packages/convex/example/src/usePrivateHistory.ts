import { useCallback, useEffect, useRef, useState } from "react";
import type { Job } from "../shared/types";
import {
  clearCachedJobs,
  listCachedJobs,
  MAX_HISTORY,
  saveCachedJob,
  withObjectUrls,
} from "./cache";

export function usePrivateHistory(token: string) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const stored = useRef(new Map<string, Job>());
  const downloads = useRef(new Map<string, Promise<void>>());
  const dismissed = useRef(new Set<string>());
  const generation = useRef(0);
  const clearingRef = useRef(false);

  const remember = useCallback((job: Job) => {
    const previous = stored.current.get(job.id);
    if (previous) previous.results.forEach((result) => URL.revokeObjectURL(result.url));
    stored.current.set(job.id, job);
    const latest = [...stored.current.values()].sort((a, b) => b.createdAt - a.createdAt);
    for (const old of latest.slice(MAX_HISTORY)) {
      old.results.forEach((result) => URL.revokeObjectURL(result.url));
      stored.current.delete(old.id);
    }
    setJobs(latest.slice(0, MAX_HISTORY));
  }, []);

  const releaseHistory = useCallback(() => {
    generation.current++;
    for (const job of stored.current.values())
      job.results.forEach((result) => URL.revokeObjectURL(result.url));
    stored.current.clear();
  }, []);

  useEffect(() => {
    if (!token) return;
    const current = ++generation.current;
    void listCachedJobs(token)
      .then((cached) => {
        if (current !== generation.current) return;
        for (const job of cached) {
          if (!stored.current.has(job.id)) remember(withObjectUrls(job));
        }
      })
      .catch(() => {
        if (current === generation.current)
          setError(
            "Browser storage is unavailable. You can still download your image while this page is open."
          );
      });
    return releaseHistory;
  }, [token, remember, releaseHistory]);

  const download = useCallback(
    (remote: Job, explicit = false): Promise<void> => {
      if (
        !token ||
        clearingRef.current ||
        !remote.results.length ||
        stored.current.has(remote.id) ||
        (!explicit && dismissed.current.has(remote.id))
      )
        return Promise.resolve();
      const pending = downloads.current.get(remote.id);
      if (pending) return pending;
      const current = generation.current;
      const operation = (async () => {
        try {
          const blobs = await Promise.all(
            remote.results.map(async (result) => {
              const response = await fetch(result.url, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(20_000),
              });
              if (!response.ok || !response.headers.get("Content-Type")?.includes("image/avif"))
                throw new Error("Image unavailable");
              const blob = await response.blob();
              if (blob.size !== result.bytes) throw new Error("Incomplete image");
              return blob;
            })
          );
          if (current !== generation.current) return;
          let cacheError: string | null = null;
          try {
            await saveCachedJob(remote, blobs, token);
          } catch {
            cacheError =
              "Your image could not be saved in this browser. Download it to keep a copy.";
          }
          if (current !== generation.current) return;
          remember({
            ...remote,
            results: remote.results.map((result, index) => ({
              ...result,
              url: URL.createObjectURL(blobs[index]!),
            })),
          });
          setError(cacheError);
        } catch {
          if (current === generation.current)
            setError("Your image could not be loaded. Its temporary server copy may have expired.");
        } finally {
          downloads.current.delete(remote.id);
        }
      })();
      downloads.current.set(remote.id, operation);
      return operation;
    },
    [token, remember]
  );

  const clear = useCallback(
    async (remoteIds: string[]) => {
      if (clearingRef.current) return;
      clearingRef.current = true;
      setClearing(true);
      generation.current++;
      remoteIds.forEach((id) => dismissed.current.add(id));
      try {
        await Promise.allSettled(downloads.current.values());
        await clearCachedJobs(token);
        for (const job of stored.current.values())
          job.results.forEach((result) => URL.revokeObjectURL(result.url));
        stored.current.clear();
        setJobs([]);
        setError(null);
      } catch {
        setError("Local history could not be cleared. Please try again.");
      } finally {
        clearingRef.current = false;
        setClearing(false);
      }
    },
    [token]
  );

  return { jobs, error, download, clear, clearing };
}
