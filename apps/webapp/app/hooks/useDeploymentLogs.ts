import { S2, S2Error } from "@s2-dev/streamstore";
import { DeploymentEventFromString } from "@trigger.dev/core/v3/schemas";
import type { WorkerDeploymentStatus } from "@trigger.dev/database";
import { useEffect, useState } from "react";
import {
  deploymentLogsCache,
  type DeploymentLogEntry,
} from "~/components/runs/v3/deploymentLogsCache";

type DeploymentEventStream = {
  s2: {
    basin: string;
    stream: string;
    accessToken: string;
  };
};

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

export function useDeploymentLogs({ eventStream, status }: UseDeploymentLogsOptions) {
  const [logs, setLogs] = useState<readonly DeploymentLogEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);

  const basin = eventStream?.s2.basin;
  const stream = eventStream?.s2.stream;
  const accessToken = eventStream?.s2.accessToken;

  useEffect(() => {
    if (!basin || !stream || !accessToken) return;

    const isFinished = FINISHED_DEPLOYMENT_STATUSES.has(status);
    const cacheKey = `${basin}/${stream}`;
    const cached = deploymentLogsCache.get(cacheKey);

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
      pending.push(entry);
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
      deploymentLogsCache.set(cacheKey, {
        logs: entries,
        nextSeqNum,
        finalized,
        complete: finalized && isFinished,
      });
    };

    const streamLogs = async () => {
      try {
        const s2 = new S2({ accessToken });
        const readSession = await s2
          .basin(basin)
          .stream(stream)
          .readSession(
            {
              start: { from: { seqNum: nextSeqNum }, clamp: true },
              stop: { waitSecs: 60 },
            },
            { signal: abortController.signal }
          );

        for await (const record of readSession) {
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
      } catch (error) {
        if (abortController.signal.aborted) return;

        if (error instanceof S2Error && error.code === "stream_not_found") {
          finalized = isFinished;
          return;
        }
        if (error instanceof S2Error && error.code === "permission_denied") return;

        console.error("Failed to stream logs:", error);
        setStreamError("Failed to stream logs");
      } finally {
        if (!abortController.signal.aborted) {
          flush();
          setIsStreaming(false);
          store();
        }
      }
    };

    streamLogs();

    return () => {
      abortController.abort();
      store();
    };
  }, [basin, stream, accessToken, status]);

  return { logs, isStreaming, streamError };
}
