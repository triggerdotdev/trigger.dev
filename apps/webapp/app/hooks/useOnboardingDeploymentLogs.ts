import { readDeploymentLogsWithRecovery } from "./deploymentLogRecovery";
import { S2, S2Error } from "@s2-dev/streamstore";
import { DeploymentEventFromString } from "@trigger.dev/core/v3/schemas";
import type { WorkerDeploymentStatus } from "@trigger.dev/database";
import { useEffect, useState } from "react";
import { classifyDeploymentLog } from "./deploymentLogFilter";
import {
  DeploymentLogsCache,
  type DeploymentLogEntry,
} from "~/components/runs/v3/deploymentLogsCache";

export type DeploymentEventStream = {
  s2: {
    basin: string;
    stream: string;
    accessToken: string;
  };
};

// Keep both entries and eviction independent from the existing deployment inspector.
const onboardingLogsCache = new DeploymentLogsCache(20, 20_000);

const FINISHED_DEPLOYMENT_STATUSES = new Set<WorkerDeploymentStatus>([
  "DEPLOYED",
  "FAILED",
  "CANCELED",
  "TIMED_OUT",
]);

type UseDeploymentLogsOptions = {
  eventStream: DeploymentEventStream | undefined;
  status: WorkerDeploymentStatus;
};

export function useOnboardingDeploymentLogs(
  { eventStream, status }: UseDeploymentLogsOptions,
  client?: S2
) {
  const [logs, setLogs] = useState<readonly DeploymentLogEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const [retryCount, setRetryCount] = useState(0);
  const basin = eventStream?.s2.basin;
  const stream = eventStream?.s2.stream;
  const accessToken = eventStream?.s2.accessToken;

  useEffect(() => {
    if (!basin || !stream || !accessToken) {
      // oxlint-disable-next-line react/set-state-in-effect -- Clear the previous external stream when credentials disappear.
      setLogs([]);
      setIsStreaming(false);
      setStreamError(null);
      return;
    }

    const isFinished = FINISHED_DEPLOYMENT_STATUSES.has(status);
    const cacheKey = `onboarding:${basin}/${stream}`;
    const cached = onboardingLogsCache.get(cacheKey);

    let entries = cached?.logs ?? [];
    let nextSeqNum = cached?.nextSeqNum ?? 0;
    let pending: DeploymentLogEntry[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let finalized = cached?.finalized ?? false;

    // oxlint-disable-next-line react/set-state-in-effect -- Seed from the cache when the selected deployment changes.
    setLogs(entries);
    setStreamError(null);

    if (cached?.complete) {
      setIsStreaming(false);
      return;
    }

    setIsStreaming(true);

    const abortController = new AbortController();

    const flush = () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      if (abortController.signal.aborted || pending.length === 0) return;
      entries = entries.concat(pending);
      pending = [];
      setLogs(entries);
    };

    const push = (entry: DeploymentLogEntry) => {
      pending.push(classifyDeploymentLog(entry));
      flushTimer ??= setTimeout(flush, 0);
    };

    const store = () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      if (pending.length > 0) {
        entries = entries.concat(pending);
        pending = [];
      }
      if (entries.length === 0 && nextSeqNum === 0 && !finalized) return;
      onboardingLogsCache.set(cacheKey, {
        logs: entries,
        nextSeqNum,
        finalized,
        complete: finalized && isFinished,
      });
    };

    const read = async () => {
      const s2Stream = (client ?? new S2({ accessToken })).basin(basin).stream(stream);

      do {
        const readSession = await s2Stream.readSession(
          {
            start: { from: { seqNum: nextSeqNum }, clamp: true },
            stop: { waitSecs: 60 },
          },
          { signal: abortController.signal }
        );

        if (abortController.signal.aborted) return;
        setStreamError(null);
        setIsStreaming(true);
        for await (const record of readSession) {
          if (abortController.signal.aborted) return;
          nextSeqNum = record.seqNum + 1;

          const decoded = record.body;
          const result = DeploymentEventFromString.safeParse(decoded);

          if (!result.success) {
            // fallback to the previous format in s2 logs for compatibility
            const headers: Record<string, string> = {};
            if (record.headers) {
              for (const [name, value] of record.headers) {
                headers[name] = value;
              }
            }
            const level =
              (headers["level"]?.toLowerCase() as DeploymentLogEntry["level"]) ?? "info";

            push({ timestamp: new Date(record.timestamp), message: decoded, level });
            continue;
          }

          const event = result.data;
          if (event.type === "finalized") finalized = true;
          if (event.type !== "log") continue;

          push({
            timestamp: new Date(record.timestamp),
            message: event.data.message,
            level: event.data.level,
          });
        }
      } while (!abortController.signal.aborted && !finalized && !isFinished);
    };

    void readDeploymentLogsWithRecovery({
      read,
      signal: abortController.signal,
      canRetry: (error) => !(error instanceof S2Error && error.code === "permission_denied"),
      onConnected: () => setStreamError(null),
      onError: (retrying) => {
        flush();
        setIsStreaming(false);
        setStreamError(
          retrying
            ? "Log connection interrupted. Reconnecting…"
            : "Logs are unavailable. Reload logs or open the deployment for details."
        );
      },
    }).finally(() => {
      if (!abortController.signal.aborted) {
        flush();
        setIsStreaming(false);
        store();
      }
    });

    return () => {
      abortController.abort();
      store();
    };
  }, [basin, stream, accessToken, status, retryCount, client]);

  return { logs, isStreaming, streamError, retry: () => setRetryCount((count) => count + 1) };
}
