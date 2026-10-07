import { tryCatch } from "@trigger.dev/core/v3";
import { useEffect, useRef } from "react";
import type { RunStatusData } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.status";

const DEFAULT_POLL_MS = 15_000;

// Polls the run status until it finishes, then calls `onFinished` once. Failed polls
// are ignored and retried on the next interval.
export function useRunStatusBackstop({
  enabled,
  statusPath,
  shouldSkip,
  onFinished,
  pollMs = DEFAULT_POLL_MS,
}: {
  enabled: boolean;
  statusPath: string;
  shouldSkip: () => boolean;
  onFinished: () => void;
  pollMs?: number;
}) {
  const shouldSkipRef = useRef(shouldSkip);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    shouldSkipRef.current = shouldSkip;
    onFinishedRef.current = onFinished;
  });

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const poll = async () => {
      if (shouldSkipRef.current()) return;
      const [fetchError, response] = await tryCatch(
        fetch(statusPath, { headers: { accept: "application/json" } })
      );
      if (stopped || fetchError || !response.ok) return;
      const [parseError, data] = await tryCatch(response.json() as Promise<RunStatusData>);
      if (stopped || parseError || (!data.isFinished && data.completedAt === null)) return;
      stopped = true;
      window.clearInterval(id);
      onFinishedRef.current();
    };
    const id = window.setInterval(() => void poll(), pollMs);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [enabled, statusPath, pollMs]);
}
