import { tryCatch } from "@trigger.dev/core/v3";
import { useEffect, useRef } from "react";
import type { RunStatusData } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.status";

const DEFAULT_POLL_MS = 15_000;

// Polls the run status and passes each result to `onStatus` until the caller disables
// it. Reloads the caller triggers can read a lagging replica or be interrupted, so the
// caller keeps polling until the page data agrees. Failed polls are ignored and retried
// on the next interval.
export function useRunStatusBackstop({
  enabled,
  statusPath,
  shouldSkip,
  onStatus,
  pollMs = DEFAULT_POLL_MS,
}: {
  enabled: boolean;
  statusPath: string;
  shouldSkip: () => boolean;
  onStatus: (data: RunStatusData) => void;
  pollMs?: number;
}) {
  const shouldSkipRef = useRef(shouldSkip);
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    shouldSkipRef.current = shouldSkip;
    onStatusRef.current = onStatus;
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
      if (stopped || parseError) return;
      onStatusRef.current(data);
    };
    const id = window.setInterval(() => void poll(), pollMs);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [enabled, statusPath, pollMs]);
}
