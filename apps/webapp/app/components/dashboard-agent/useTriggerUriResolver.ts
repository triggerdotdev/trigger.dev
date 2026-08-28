import { isTriggerUri } from "@internal/dashboard-agent-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ResolvedUri } from "./ReportView";
import {
  MAX_RESOLVE_ATTEMPTS,
  planUriBatches,
  RESOLVE_RETRY_DELAY_MS,
  shouldScheduleRetry,
} from "./resolve-uris";

/**
 * Synchronous facade over the panel's async `resolve-many` action: the first render of a URI
 * returns null. A "nothing to open" answer is cached, a transient failure is retried a few times.
 */
export function useTriggerUriResolver(actionPath: string): (uri: string) => ResolvedUri | null {
  const [resolved, setResolved] = useState<Record<string, ResolvedUri | null>>({});
  // Mirrors `resolved` for the flush, which runs after a delay and must not read a stale closure.
  const answered = useRef<Record<string, ResolvedUri | null>>({});
  // URIs the cards asked about this render; a ref because it's written during render.
  const seen = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const attempts = useRef(new Map<string, number>());
  const retryTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);

  const resolveUri = useCallback(
    (uri: string): ResolvedUri | null => {
      if (!isTriggerUri(uri)) return null;
      if (!(uri in resolved)) seen.current.add(uri);
      return resolved[uri] ?? null;
    },
    [resolved]
  );

  const record = useCallback((entries: Record<string, ResolvedUri | null>) => {
    if (!mounted.current) return;
    answered.current = { ...answered.current, ...entries };
    setResolved((previous) => ({ ...previous, ...entries }));
  }, []);

  const flushRef = useRef<() => void>(() => {});

  const flush = useCallback(() => {
    const pending = [...seen.current].filter(
      (uri) => !(uri in answered.current) && !inFlight.current.has(uri)
    );
    if (pending.length === 0) return;

    for (const batch of planUriBatches(pending)) {
      for (const uri of batch) inFlight.current.add(uri);

      const body = new FormData();
      body.set("intent", "resolve-many");
      body.set("uris", JSON.stringify(batch));

      fetch(actionPath, { method: "POST", body })
        .then(async (res) => {
          if (!res.ok) throw new Error(`Failed to resolve links (${res.status})`);
          return (await res.json()) as {
            resolved?: Record<string, { path?: string; label?: string } | null>;
          };
        })
        .then((data) => {
          // A 200 is the definitive answer, including "nothing to open": cached for good.
          const entries: Record<string, ResolvedUri | null> = {};
          for (const uri of batch) {
            const hit = data.resolved?.[uri];
            entries[uri] = hit?.path ? { url: hit.path, label: hit.label ?? uri } : null;
          }
          record(entries);
        })
        .catch(() => {
          // Transient: a 5xx, a network blip, a deploy. Retried, then given up on.
          const exhausted: Record<string, ResolvedUri | null> = {};
          for (const uri of batch) {
            const tried = (attempts.current.get(uri) ?? 0) + 1;
            attempts.current.set(uri, tried);
            if (tried >= MAX_RESOLVE_ATTEMPTS) exhausted[uri] = null;
          }
          if (Object.keys(exhausted).length > 0) record(exhausted);
          // One timer for all batches; a render may never follow, so it can't be the trigger.
          if (
            shouldScheduleRetry({
              mounted: mounted.current,
              timerPending: retryTimer.current !== undefined,
            })
          ) {
            retryTimer.current = window.setTimeout(() => {
              retryTimer.current = undefined;
              flushRef.current();
            }, RESOLVE_RETRY_DELAY_MS);
          }
        })
        .finally(() => {
          for (const uri of batch) inFlight.current.delete(uri);
        });
    }
  }, [actionPath, record]);

  // No dependency array on purpose: after every render, fetch whatever the cards
  // asked about that hasn't been answered yet.
  useEffect(() => {
    flushRef.current = flush;
    flush();
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current !== undefined) window.clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    };
  }, []);

  return resolveUri;
}
