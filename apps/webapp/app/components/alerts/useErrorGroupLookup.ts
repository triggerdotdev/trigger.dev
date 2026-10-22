import { useEffect, useMemo, useRef, useState } from "react";
import type { CreationFlowState } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import { encodeErrorGroupScope } from "~/utils/errorGroupScope";
import {
  errorGroupResolver,
  type ErrorGroupOption,
  type ResolveErrorGroup,
} from "./errorGroupOptions";

/** The recent error groups (loaded once enabled) and a resolver for typed ids. */
export function useErrorGroupSource(url: string, enabled: boolean) {
  const [loaded, setLoaded] = useState<{ url: string; groups: ErrorGroupOption[] }>();
  const resolve = useMemo(() => errorGroupResolver(url), [url]);
  const needsLoad = enabled && loaded?.url !== url;
  useEffect(() => {
    if (!needsLoad) return;
    let cancelled = false;
    fetch(url)
      .then((res) => (res.ok ? (res.json() as Promise<{ groups?: ErrorGroupOption[] }>) : {}))
      .catch(() => ({}) as { groups?: ErrorGroupOption[] })
      .then((data: { groups?: ErrorGroupOption[] }) => {
        if (!cancelled) setLoaded({ url, groups: data.groups ?? [] });
      });
    return () => {
      cancelled = true;
    };
  }, [needsLoad, url]);
  return { groups: loaded?.url === url ? loaded.groups : undefined, resolve };
}

/** Resolves a typed error id and sets it as the flow's error group scope. */
export function useErrorGroupLookup(
  flow: CreationFlowState,
  resolve: ResolveErrorGroup | undefined
) {
  const [lookupError, setLookupError] = useState<string>();
  const flowRef = useRef(flow);
  // oxlint-disable-next-line react/refs -- Latest-value ref kept in sync during render on purpose.
  flowRef.current = flow;
  const seqRef = useRef(0);
  const { answers } = flow;
  useEffect(() => {
    seqRef.current++;
  }, [answers]);
  useEffect(
    () => () => {
      seqRef.current++;
    },
    []
  );
  const lookup = resolve
    ? (id: string) => {
        setLookupError(undefined);
        const seq = ++seqRef.current;
        void resolve(id).then((group) => {
          if (seq !== seqRef.current) return;
          if (!group) {
            setLookupError(`No error found for ${id}`);
            return;
          }
          flowRef.current.selectChip("scope", "errorGroup");
          flowRef.current.setScopeValue(encodeErrorGroupScope(group));
        });
      }
    : undefined;
  return { lookup, lookupError };
}
