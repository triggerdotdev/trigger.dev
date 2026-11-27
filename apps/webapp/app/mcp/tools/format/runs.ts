import type { TaskRunErrorCause } from "@trigger.dev/core/v3";
import { formatErrorCauses } from "@trigger.dev/core/v3/errors";
import type {
  ListRunResponseItem,
  RetrieveRunResponse,
  RetrieveRunTraceResponseBody,
  RetrieveSpanDetailResponseBody,
} from "@trigger.dev/core/v3/schemas";
import { isRunFriendlyId } from "~/components/dashboard-agent/run-id";
import { fenceUntrusted } from "../../gate/fence.server";
import { untrusted } from "./logFields";

const METADATA_CHARS = 4_000;

type RunShape = {
  id: string;
  taskIdentifier: string;
  status: string;
  output?: unknown;
  error?: { name?: string; message: string; causes?: TaskRunErrorCause[] };
  metadata?: unknown;
  createdAt: Date;
  finishedAt?: Date;
};

type RunsPage = {
  data: ListRunResponseItem[];
  pagination: { next?: string; previous?: string };
};

function causeLines(causes: TaskRunErrorCause[] | undefined): string[] {
  return formatErrorCauses(causes).split("\n").filter(Boolean);
}

function fencedError(error: NonNullable<RunShape["error"]>, extra: string[] = []): string {
  const text = [
    `${error.name || "Error"}: ${error.message}`,
    ...causeLines(error.causes),
    ...extra,
  ];
  return fenceUntrusted(text.join("\n"), "run-error");
}

export function formatRun(
  run: RetrieveRunResponse,
  queueing: {
    priorityMs?: number;
    concurrencyKey?: string | null;
    payload?: string | null;
    payloadType?: string | null;
    output?: string | null;
    outputType?: string | null;
  } = {}
): string {
  const lines: string[] = [];

  lines.push(`Run ${run.id}`);
  lines.push(`Task: ${run.taskIdentifier}`);
  lines.push(`Status: ${formatStatus(run.status)}`);

  const timing = formatTiming(run);
  if (timing) {
    lines.push(`Timing: ${timing}`);
  }

  if (run.durationMs > 0) {
    lines.push(`Duration: ${formatDuration(run.durationMs)}`);
  }

  if (run.costInCents > 0) {
    lines.push(`Cost: $${(run.costInCents / 100).toFixed(4)}`);
  }

  if (run.attemptCount > 1) {
    lines.push(`Attempts: ${run.attemptCount}`);
  }

  if (run.version) {
    lines.push(`Version: ${run.version}`);
  }

  if (run.tags && run.tags.length > 0) {
    lines.push(`Tags: ${fenceUntrusted(run.tags.join(", "), "run-tags")}`);
  }

  if (run.error) {
    const stack = run.error.stackTrace ? [`Stack: ${run.error.stackTrace.split("\n")[0]}`] : [];
    lines.push(`Error: ${fencedError(run.error, stack)}`);
  }

  const relatedInfo = formatRelatedRuns(run.relatedRuns);
  if (relatedInfo) {
    lines.push(relatedInfo);
  }

  if (run.schedule) {
    lines.push(
      `Schedule: ${fenceUntrusted(run.schedule.generator.expression, "run-schedule")} (${run.schedule.id})`
    );
  }

  if (run.batchId) {
    lines.push(`Batch: ${run.batchId}`);
  }

  if (run.isTest) {
    lines.push(`Test run`);
  }

  if (run.ttl) {
    lines.push(`TTL: ${run.ttl}`);
  }

  if (queueing.priorityMs) {
    lines.push(`Priority: ${queueing.priorityMs / 1000}s`);
  }

  if (queueing.concurrencyKey) {
    lines.push(
      `Concurrency key: ${fenceUntrusted(queueing.concurrencyKey, "run-concurrency-key")}`
    );
  }

  const payload = decodedValue(run.payload, queueing.payload, queueing.payloadType);
  if (payload !== undefined) {
    lines.push(`Payload: ${fenceUntrusted(JSON.stringify(payload, null, 2), "run-payload")}`);
  } else if (run.payloadPresignedUrl) {
    lines.push(`Payload: (large payload available via presigned URL: ${run.payloadPresignedUrl})`);
  }

  const output = decodedValue(
    run.output,
    run.status === "COMPLETED" ? queueing.output : undefined,
    queueing.outputType
  );
  if (output !== undefined) {
    lines.push(`Output: ${fenceUntrusted(JSON.stringify(output, null, 2), "run-output")}`);
  } else if (run.outputPresignedUrl) {
    lines.push(`Output: (large output available via presigned URL: ${run.outputPresignedUrl})`);
  }

  if (run.metadata && Object.keys(run.metadata).length > 0) {
    const json = JSON.stringify(run.metadata, null, 2);
    const body =
      json.length > METADATA_CHARS
        ? `${json.slice(0, METADATA_CHARS)}\n… (truncated, ${json.length} characters in total)`
        : json;
    lines.push(`Metadata: ${fenceUntrusted(body, "run-metadata")}`);
  }

  return lines.join("\n");
}

export function formatRunShape(run: RunShape): string {
  const lines: string[] = [];

  lines.push(`Run ${run.id}`);
  lines.push(`Task: ${run.taskIdentifier}`);
  lines.push(`Status: ${formatStatus(run.status)}`);

  if (run.output !== undefined) {
    lines.push(`Output: ${fenceUntrusted(JSON.stringify(run.output, null, 2), "run-output")}`);
  }

  if (run.error) {
    lines.push(`Error: ${fencedError(run.error)}`);
  }

  if (run.metadata) {
    lines.push(
      `Metadata: ${fenceUntrusted(JSON.stringify(run.metadata, null, 2), "run-metadata")}`
    );
  }

  lines.push(`Created at: ${formatDateTime(run.createdAt)}`);

  if (run.finishedAt) {
    lines.push(`Finished at: ${formatDateTime(run.finishedAt)}`);
  }

  return lines.join("\n");
}

// parsePacketAsJson drops empty data, but the SDK stores "" as an empty text/plain packet.
function decodedValue(
  decoded: unknown,
  raw: string | null | undefined,
  type: string | null | undefined
): unknown {
  return decoded === undefined && raw === "" && type === "text/plain" ? "" : decoded;
}

const SPAN_ID = /^[0-9a-f]{16}$/;
const fencedRunId = (id: string) =>
  id.length <= 128 && isRunFriendlyId(id) ? id : untrusted(id, "run-id", 128);

/** Names the run asked for and where to find the right id, only in this environment. */
export const runNotFound = (id: string) =>
  `Run ${fencedRunId(id)} was not found in this environment. Use list_runs to find it.`;

export const invalidTraceCursor = (id: string) =>
  `The cursor is not valid for run ${fencedRunId(id)}. Call get_run_details without a cursor to start from the first page.`;

export const traceNotFound = (id: string) =>
  `The trace of run ${fencedRunId(id)} was not found. Call get_run_details without a cursor to see the run details.`;

export const spanNotFound = (spanId: string, runId: string) =>
  `Span ${SPAN_ID.test(spanId) ? spanId : untrusted(spanId, "span-id", 64)} was not found in run ${fencedRunId(runId)}. Use get_run_details to list its spans.`;

export function formatStatus(status: string): string {
  return status.toLowerCase().replace(/_/g, " ");
}

function formatTiming(run: RetrieveRunResponse): string | null {
  const parts: string[] = [];

  parts.push(`created ${formatDateTime(run.createdAt)}`);

  if (run.startedAt) {
    parts.push(`started ${formatDateTime(run.startedAt)}`);
  }

  if (run.finishedAt) {
    parts.push(`finished ${formatDateTime(run.finishedAt)}`);
  } else if (run.delayedUntil) {
    parts.push(`delayed until ${formatDateTime(run.delayedUntil)}`);
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

function formatDateTime(date: Date | undefined): string {
  if (!date) return "unknown";

  try {
    return date
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, " UTC");
  } catch {
    return "unknown";
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  if (durationMs < 3600000) return `${(durationMs / 60000).toFixed(1)}m`;
  return `${(durationMs / 3600000).toFixed(1)}h`;
}

function formatRelatedRuns(relatedRuns: RetrieveRunResponse["relatedRuns"]): string | null {
  const parts: string[] = [];

  if (relatedRuns.parent) {
    parts.push(`parent: ${relatedRuns.parent.id} (${formatStatus(relatedRuns.parent.status)})`);
  }

  if (relatedRuns.root && relatedRuns.root.id !== relatedRuns.parent?.id) {
    parts.push(`root: ${relatedRuns.root.id} (${formatStatus(relatedRuns.root.status)})`);
  }

  if (relatedRuns.children && relatedRuns.children.length > 0) {
    const childStatuses = relatedRuns.children.reduce(
      (acc, child) => {
        const status = formatStatus(child.status);
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const statusSummary = Object.entries(childStatuses)
      .map(([status, count]) => `${count} ${status}`)
      .join(", ");

    parts.push(`children: ${relatedRuns.children.length} runs (${statusSummary})`);
  }

  return parts.length > 0 ? `Related: ${parts.join("; ")}` : null;
}

// The whole trace is user-emitted data, so callers fence the joined lines.
export function formatRunTrace(trace: RetrieveRunTraceResponseBody["trace"]): string {
  const lines: string[] = [];

  lines.push(`Trace ID: ${trace.traceId}`);
  lines.push("");

  formatSpan(trace.rootSpan, lines, 0);

  return lines.join("\n");
}

type TraceSpan = RetrieveRunTraceResponseBody["trace"]["rootSpan"];

function formatSpan(span: TraceSpan, lines: string[], depth: number) {
  const indent = "  ".repeat(depth);
  const prefix = depth === 0 ? "└─" : "├─";

  const statusIndicator = getStatusIndicator(span.data);
  const duration = formatDuration(span.data.duration / 1_000_000);
  const startTime = formatDateTime(span.data.startTime);

  lines.push(`${indent}${prefix} [${span.id}] ${span.data.message} ${statusIndicator}`);
  lines.push(`${indent}   Duration: ${duration}`);
  lines.push(`${indent}   Started: ${startTime}`);

  if (span.data.taskSlug) {
    lines.push(`${indent}   Task: ${span.data.taskSlug}`);
  }

  if (span.data.taskPath) {
    lines.push(`${indent}   Path: ${span.data.taskPath}`);
  }

  if (span.data.queueName) {
    lines.push(`${indent}   Queue: ${span.data.queueName}`);
  }

  if (span.data.machinePreset) {
    lines.push(`${indent}   Machine: ${span.data.machinePreset}`);
  }

  if (span.data.workerVersion) {
    lines.push(`${indent}   Worker: ${span.data.workerVersion}`);
  }

  if (span.data.properties && Object.keys(span.data.properties).length > 0) {
    lines.push(
      `${indent}   Properties: ${JSON.stringify(span.data.properties, null, 2).replace(
        /\n/g,
        "\n" + indent + "     "
      )}`
    );
  }

  if (span.data.output) {
    lines.push(
      `${indent}   Output: ${JSON.stringify(span.data.output, null, 2).replace(
        /\n/g,
        "\n" + indent + "     "
      )}`
    );
  }

  if (span.data.events && span.data.events.length > 0) {
    lines.push(`${indent}   Events: ${span.data.events.length} events`);
    const maxEvents = 3;
    for (let i = 0; i < Math.min(span.data.events.length, maxEvents); i++) {
      const event = span.data.events[i];
      if (typeof event === "object" && event !== null) {
        const eventStr = JSON.stringify(event, null, 2).replace(/\n/g, "\n" + indent + "       ");
        lines.push(`${indent}     [${i + 1}] ${eventStr}`);
      }
    }
    if (span.data.events.length > maxEvents) {
      lines.push(`${indent}     ... and ${span.data.events.length - maxEvents} more events`);
    }
  }

  if (span.children && span.children.length > 0) {
    lines.push("");
  }

  if (span.children) {
    span.children.forEach((child, index) => {
      formatSpan(child, lines, depth + 1);
      if (index < span.children.length - 1) {
        lines.push("");
      }
    });
  }
}

function getStatusIndicator(spanData: TraceSpan["data"]): string {
  if (spanData.isCancelled) return "[CANCELLED]";
  if (spanData.isError) return "[ERROR]";
  if (spanData.isPartial) return "[PARTIAL]";
  return "[COMPLETED]";
}

export function formatRunList(runsPage: RunsPage): string {
  const lines: string[] = [];

  const totalRuns = runsPage.data.length;
  lines.push(`Found ${totalRuns} run${totalRuns === 1 ? "" : "s"}`);
  lines.push("");

  if (totalRuns === 0) {
    lines.push("No runs found.");
    return lines.join("\n");
  }

  runsPage.data.forEach((run, index) => {
    lines.push(`${index + 1}. ${formatRunSummary(run)}`);
  });

  lines.push("");
  const paginationInfo = [];
  if (runsPage.pagination.previous) {
    paginationInfo.push("← Previous page available");
  }
  if (runsPage.pagination.next) {
    paginationInfo.push("Next page available →");
  }

  if (paginationInfo.length > 0) {
    lines.push(`Pagination: ${paginationInfo.join(" | ")}`);
    if (runsPage.pagination.next) {
      lines.push(`Next cursor: ${runsPage.pagination.next}`);
    }
    if (runsPage.pagination.previous) {
      lines.push(`Previous cursor: ${runsPage.pagination.previous}`);
    }
  }

  return lines.join("\n");
}

function formatRunSummary(run: ListRunResponseItem): string {
  const parts: string[] = [];

  parts.push(`${run.id}`);
  parts.push(fenceUntrusted(run.taskIdentifier, "run-task"));
  parts.push(`${formatStatus(run.status)}`);

  parts.push(`env:${fenceUntrusted(run.env.name, "run-env")}`);

  let timeInfo = "";
  if (run.finishedAt) {
    timeInfo = `finished ${formatDateTime(run.finishedAt)}`;
  } else if (run.startedAt) {
    timeInfo = `started ${formatDateTime(run.startedAt)}`;
  } else if (run.delayedUntil) {
    timeInfo = `delayed until ${formatDateTime(run.delayedUntil)}`;
  } else {
    timeInfo = `created ${formatDateTime(run.createdAt)}`;
  }
  parts.push(timeInfo);

  if (run.durationMs > 0) {
    parts.push(`took ${formatDuration(run.durationMs)}`);
  }

  if (run.costInCents > 0) {
    parts.push(`$${(run.costInCents / 100).toFixed(4)}`);
  }

  if (run.tags && run.tags.length > 0) {
    const tagStr =
      run.tags.length > 2
        ? `${run.tags.slice(0, 2).join(", ")}+${run.tags.length - 2}`
        : run.tags.join(", ");
    parts.push(`tags:[${fenceUntrusted(tagStr, "run-tags")}]`);
  }

  if (run.isTest) {
    parts.push("[TEST]");
  }

  if (run.version) {
    parts.push(`v${run.version}`);
  }

  if (run.region) {
    parts.push(`region:${run.region}`);
  }

  return parts.join(" | ");
}

export function formatSpanDetail(span: RetrieveSpanDetailResponseBody): string {
  const lines: string[] = [];

  const statusIndicator = span.isCancelled
    ? "[CANCELLED]"
    : span.isError
      ? "[ERROR]"
      : span.isPartial
        ? "[IN PROGRESS]"
        : "[COMPLETED]";

  lines.push(`## Span: ${fenceUntrusted(span.message, "span-message")} ${statusIndicator}`);
  lines.push(`Span ID: ${span.spanId}`);
  if (span.parentId) lines.push(`Parent ID: ${span.parentId}`);
  lines.push(`Run ID: ${span.runId}`);
  lines.push(`Level: ${span.level}`);
  lines.push(`Started: ${formatDateTime(span.startTime)}`);
  lines.push(`Duration: ${formatDuration(span.durationMs)}`);
  if (span.entityType) lines.push(`Entity Type: ${span.entityType}`);

  if (span.ai) {
    lines.push("");
    lines.push("### AI Details");
    lines.push(`Model: ${fenceUntrusted(String(span.ai.model), "span-ai")}`);
    lines.push(`Provider: ${fenceUntrusted(String(span.ai.provider), "span-ai")}`);
    lines.push(`Operation: ${fenceUntrusted(String(span.ai.operationName), "span-ai")}`);
    lines.push(
      `Tokens: ${span.ai.inputTokens} in / ${span.ai.outputTokens} out (${span.ai.totalTokens} total)`
    );
    if (span.ai.cachedTokens) {
      lines.push(`Cached tokens: ${span.ai.cachedTokens}`);
    }
    if (span.ai.reasoningTokens) {
      lines.push(`Reasoning tokens: ${span.ai.reasoningTokens}`);
    }
    if (span.ai.totalCost !== undefined) {
      lines.push(`Cost: $${span.ai.totalCost.toFixed(6)}`);
      if (span.ai.inputCost !== undefined && span.ai.outputCost !== undefined) {
        lines.push(
          `  Input: $${span.ai.inputCost.toFixed(6)}, Output: $${span.ai.outputCost.toFixed(6)}`
        );
      }
    }
    if (span.ai.tokensPerSecond !== undefined) {
      lines.push(`Speed: ${span.ai.tokensPerSecond} tokens/sec`);
    }
    if (span.ai.msToFirstChunk !== undefined) {
      lines.push(`Time to first chunk: ${span.ai.msToFirstChunk.toFixed(0)}ms`);
    }
    if (span.ai.finishReason) {
      lines.push(`Finish reason: ${fenceUntrusted(String(span.ai.finishReason), "span-ai")}`);
    }
    if (span.ai.responseText) {
      lines.push("");
      lines.push("### AI Response");
      lines.push(fenceUntrusted(span.ai.responseText, "span-ai-response"));
    }
  }

  if (span.properties && Object.keys(span.properties).length > 0) {
    lines.push("");
    lines.push("### Properties");
    lines.push(fenceUntrusted(JSON.stringify(span.properties, null, 2), "span-properties"));
  }

  if (span.events && span.events.length > 0) {
    lines.push("");
    lines.push(`### Events (${span.events.length})`);
    const maxEvents = 10;
    const events: string[] = [];
    for (let i = 0; i < Math.min(span.events.length, maxEvents); i++) {
      const event = span.events[i];
      if (typeof event === "object" && event !== null) {
        events.push(JSON.stringify(event, null, 2));
      }
    }
    if (events.length > 0) {
      lines.push(fenceUntrusted(events.join("\n"), "span-events"));
    }
    if (span.events.length > maxEvents) {
      lines.push(`... and ${span.events.length - maxEvents} more events`);
    }
  }

  if (span.triggeredRuns && span.triggeredRuns.length > 0) {
    lines.push("");
    lines.push("### Triggered Runs");
    for (const run of span.triggeredRuns) {
      lines.push(`- ${run.runId} (${run.taskIdentifier}) - ${run.status.toLowerCase()}`);
    }
  }

  return lines.join("\n");
}
