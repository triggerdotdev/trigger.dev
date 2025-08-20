import {
  ListRunResponseItem,
  RetrieveRunResponse,
  RetrieveRunTraceResponseBody,
} from "@trigger.dev/core/v3/schemas";
import type { CursorPageResponse } from "@trigger.dev/core/v3/zodfetch";

const MAX_TRACE_LINES = 1000;

export function formatRun(run: RetrieveRunResponse): string {
  const lines: string[] = [];

  // Header with basic info
  lines.push(`Run ${run.id}`);
  lines.push(`Task: ${run.taskIdentifier}`);
  lines.push(`Status: ${formatStatus(run.status)}`);

  // Timing information
  const timing = formatTiming(run);
  if (timing) {
    lines.push(`Timing: ${timing}`);
  }

  // Duration and cost
  if (run.durationMs > 0) {
    lines.push(`Duration: ${formatDuration(run.durationMs)}`);
  }

  if (run.costInCents > 0) {
    lines.push(`Cost: $${(run.costInCents / 100).toFixed(4)}`);
  }

  // Attempt count
  if (run.attemptCount > 1) {
    lines.push(`Attempts: ${run.attemptCount}`);
  }

  // Version and trigger info
  if (run.version) {
    lines.push(`Version: ${run.version}`);
  }

  // Tags
  if (run.tags && run.tags.length > 0) {
    lines.push(`Tags: ${run.tags.join(", ")}`);
  }

  // Error information
  if (run.error) {
    lines.push(`Error: ${run.error.name || "Error"}: ${run.error.message}`);
    if (run.error.stackTrace) {
      lines.push(`Stack: ${run.error.stackTrace.split("\n")[0]}`); // First line only
    }
  }

  // Related runs
  const relatedInfo = formatRelatedRuns(run.relatedRuns);
  if (relatedInfo) {
    lines.push(relatedInfo);
  }

  // Schedule info
  if (run.schedule) {
    lines.push(`Schedule: ${run.schedule.generator.expression} (${run.schedule.id})`);
  }

  // Batch info
  if (run.batchId) {
    lines.push(`Batch: ${run.batchId}`);
  }

  // Test flag
  if (run.isTest) {
    lines.push(`Test run`);
  }

  // TTL info
  if (run.ttl) {
    lines.push(`TTL: ${run.ttl}`);
  }

  // Payload and Output data
  if (run.payload) {
    lines.push(`Payload: ${JSON.stringify(run.payload, null, 2)}`);
  } else if (run.payloadPresignedUrl) {
    lines.push(`Payload: (large payload available via presigned URL: ${run.payloadPresignedUrl})`);
  }

  if (run.output) {
    lines.push(`Output: ${JSON.stringify(run.output, null, 2)}`);
  } else if (run.outputPresignedUrl) {
    lines.push(`Output: (large output available via presigned URL: ${run.outputPresignedUrl})`);
  }

  // Metadata
  if (run.metadata && Object.keys(run.metadata).length > 0) {
    lines.push(`Metadata: ${Object.keys(run.metadata).length} fields`);
  }

  return lines.join("\n");
}

function formatStatus(status: string): string {
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
    parts.push(`parent: ${relatedRuns.parent.id} (${relatedRuns.parent.status.toLowerCase()})`);
  }

  if (relatedRuns.root && relatedRuns.root.id !== relatedRuns.parent?.id) {
    parts.push(`root: ${relatedRuns.root.id} (${relatedRuns.root.status.toLowerCase()})`);
  }

  if (relatedRuns.children && relatedRuns.children.length > 0) {
    const childStatuses = relatedRuns.children.reduce(
      (acc, child) => {
        acc[child.status.toLowerCase()] = (acc[child.status.toLowerCase()] || 0) + 1;
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

export function formatRunTrace(trace: RetrieveRunTraceResponseBody["trace"]): string {
  const lines: string[] = [];

  lines.push(`Trace ID: ${trace.traceId}`);
  lines.push("");

  // Format the root span and its children recursively
  const reachedMaxLines = formatSpan(trace.rootSpan, lines, 0, MAX_TRACE_LINES);

  if (reachedMaxLines) {
    lines.push(`(truncated logs to ${MAX_TRACE_LINES} lines)`);
  }

  return lines.join("\n");
}

function formatSpan(
  span: RetrieveRunTraceResponseBody["trace"]["rootSpan"],
  lines: string[],
  depth: number,
  maxLines: number
): boolean {
  if (lines.length >= maxLines) {
    return true;
  }

  const indent = "  ".repeat(depth);
  const prefix = depth === 0 ? "└─" : "├─";

  // Format span header
  const statusIndicator = getStatusIndicator(span.data);
  const duration = formatDuration(span.data.duration);
  const startTime = formatDateTime(span.data.startTime);

  lines.push(`${indent}${prefix} ${span.message} ${statusIndicator}`);
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

  // Show properties if they exist
  if (span.data.properties && Object.keys(span.data.properties).length > 0) {
    lines.push(
      `${indent}   Properties: ${JSON.stringify(span.data.properties, null, 2).replace(
        /\n/g,
        "\n" + indent + "     "
      )}`
    );
  }

  // Show output if it exists
  if (span.data.output) {
    lines.push(
      `${indent}   Output: ${JSON.stringify(span.data.output, null, 2).replace(
        /\n/g,
        "\n" + indent + "     "
      )}`
    );
  }

  // Show events if they exist and are meaningful
  if (span.data.events && span.data.events.length > 0) {
    lines.push(`${indent}   Events: ${span.data.events.length} events`);
    // Optionally show first few events for context
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

  // Add spacing between spans
  if (span.children && span.children.length > 0) {
    lines.push("");
  }

  // Recursively format children
  if (span.children) {
    const reachedMaxLines = span.children.some((child, index) => {
      const reachedMaxLines = formatSpan(child, lines, depth + 1, maxLines);
      // Add spacing between sibling spans (except for the last one)
      if (index < span.children.length - 1 && !reachedMaxLines) {
        lines.push("");
      }

      return reachedMaxLines;
    });

    return reachedMaxLines;
  }

  return false;
}

function getStatusIndicator(
  spanData: RetrieveRunTraceResponseBody["trace"]["rootSpan"]["data"]
): string {
  if (spanData.isCancelled) return "[CANCELLED]";
  if (spanData.isError) return "[ERROR]";
  if (spanData.isPartial) return "[PARTIAL]";
  return "[COMPLETED]";
}

export function formatRunList(runsPage: CursorPageResponse<ListRunResponseItem>): string {
  const lines: string[] = [];

  // Header with count info
  const totalRuns = runsPage.data.length;
  lines.push(`Found ${totalRuns} run${totalRuns === 1 ? "" : "s"}`);
  lines.push("");

  if (totalRuns === 0) {
    lines.push("No runs found.");
    return lines.join("\n");
  }

  // Format each run in a compact table-like format
  runsPage.data.forEach((run, index) => {
    lines.push(`${index + 1}. ${formatRunSummary(run)}`);
  });

  // Pagination info
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

  // Basic info: ID, task, status
  parts.push(`${run.id}`);
  parts.push(`${run.taskIdentifier}`);
  parts.push(`${formatStatus(run.status)}`);

  // Environment
  parts.push(`env:${run.env.name}`);

  // Timing - show the most relevant time
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

  // Duration if available
  if (run.durationMs > 0) {
    parts.push(`took ${formatDuration(run.durationMs)}`);
  }

  // Cost if significant
  if (run.costInCents > 0) {
    parts.push(`$${(run.costInCents / 100).toFixed(4)}`);
  }

  // Tags if present
  if (run.tags && run.tags.length > 0) {
    const tagStr =
      run.tags.length > 2
        ? `${run.tags.slice(0, 2).join(", ")}+${run.tags.length - 2}`
        : run.tags.join(", ");
    parts.push(`tags:[${tagStr}]`);
  }

  // Test flag
  if (run.isTest) {
    parts.push("[TEST]");
  }

  // Version if available
  if (run.version) {
    parts.push(`v${run.version}`);
  }

  return parts.join(" | ");
}
