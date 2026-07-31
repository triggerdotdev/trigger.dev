import { isTriggerUri } from "@internal/dashboard-agent-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ResolvedUri } from "./ReportView";

/**
 * A synchronous `resolveUri` for the cards, backed by the panel's async
 * `resolve` action. Resolution needs the server (environment scope, connected
 * repository), but the cards read links during render — so the first render of
 * a URI returns null (the card shows the raw URI), the answer is fetched once,
 * and the re-render turns it into a link. Failures cache as null, so a URI the
 * server can't resolve is asked about exactly once.
 */
export function useTriggerUriResolver(actionPath: string): (uri: string) => ResolvedUri | null {
  const [resolved, setResolved] = useState<Record<string, ResolvedUri | null>>({});
  // URIs the cards asked about this render; a ref because it's written during render.
  const seen = useRef(new Set<string>());
  const requested = useRef(new Set<string>());

  const resolveUri = useCallback(
    (uri: string): ResolvedUri | null => {
      if (!isTriggerUri(uri)) return null;
      if (!(uri in resolved)) seen.current.add(uri);
      return resolved[uri] ?? null;
    },
    [resolved]
  );

  // No dependency array on purpose: after every render, fetch whatever the
  // cards asked about that hasn't been requested yet.
  useEffect(() => {
    const toFetch = [...seen.current].filter((uri) => !requested.current.has(uri));
    for (const uri of toFetch) {
      requested.current.add(uri);
      const body = new FormData();
      body.set("intent", "resolve");
      body.set("uri", uri);
      fetch(actionPath, { method: "POST", body })
        .then((res) => (res.ok ? (res.json() as Promise<{ path?: string; label?: string }>) : null))
        .then((data) => {
          setResolved((prev) => ({
            ...prev,
            [uri]: data?.path ? { url: data.path, label: data.label ?? uri } : null,
          }));
        })
        .catch(() => {
          setResolved((prev) => ({ ...prev, [uri]: null }));
        });
    }
  });

  return resolveUri;
}
