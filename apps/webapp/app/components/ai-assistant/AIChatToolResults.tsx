import { useNavigate } from "@remix-run/react";
import { useState } from "react";
import type { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { v3RunPath, v3RunsPath } from "~/utils/pathBuilder";
import { useAIChat } from "./AIChatProvider";

// ---------------------------------------------------------------------------
// Failure summary card — renders the structured output of `classifyFailure`.
// ---------------------------------------------------------------------------

interface FailureClassification {
  category: string;
  confidence: string;
  evidence: string;
  nextSteps: string[];
}

const CATEGORY_BADGE: Record<string, string> = {
  Timeout: "bg-amber-500/10 text-amber-400",
  "OOM / Memory": "bg-rose-500/10 text-rose-400",
  "Missing env var": "bg-yellow-500/10 text-yellow-400",
  "Child task failed": "bg-orange-500/10 text-orange-400",
  "User code exception": "bg-rose-500/10 text-rose-400",
  "AI provider rate limit": "bg-amber-500/10 text-amber-400",
  "Deploy regression": "bg-purple-500/10 text-purple-400",
  "Platform issue": "bg-charcoal-600 text-text-dimmed",
  Unknown: "bg-charcoal-600 text-text-dimmed",
};

export function FailureSummaryCard({
  result,
  runFriendlyId,
  onSendMessage,
}: {
  result: FailureClassification;
  runFriendlyId?: string;
  onSendMessage?: (text: string) => void;
}) {
  const navigate = useNavigate();
  const { pageContext } = useAIChat();
  const badge = CATEGORY_BADGE[result.category] ?? CATEGORY_BADGE.Unknown;

  const openRun = () => {
    if (!runFriendlyId) return;
    navigate(
      v3RunPath(
        { slug: pageContext.organizationSlug },
        { slug: pageContext.projectSlug },
        { slug: pageContext.environmentSlug },
        { friendlyId: runFriendlyId }
      )
    );
  };

  return (
    <div className="my-1 flex flex-col gap-2 rounded-md border border-rose-500/20 bg-rose-500/5 p-3 animate-in fade-in slide-in-from-bottom-1 duration-150">
      <span
        className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge}`}
      >
        {result.category}
      </span>

      <span className="text-xs text-text-dimmed">{result.confidence} confidence</span>

      {result.evidence && (
        <div className="text-xs text-text-dimmed">
          <span className="font-medium text-text-bright">Evidence: </span>
          {result.evidence}
        </div>
      )}

      {result.nextSteps?.length > 0 && (
        <ol className="ml-4 list-decimal space-y-0.5 text-xs text-text-bright">
          {result.nextSteps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}

      {(runFriendlyId || onSendMessage) && (
        <div className="mt-1 flex items-center gap-2 border-t border-grid-bright pt-1">
          {runFriendlyId && (
            <button
              type="button"
              onClick={openRun}
              className="cursor-pointer text-xs text-indigo-400 hover:text-indigo-300"
            >
              Open run
            </button>
          )}
          {runFriendlyId && onSendMessage && (
            <button
              type="button"
              onClick={() => onSendMessage(`Show me the run graph for ${runFriendlyId}`)}
              className="cursor-pointer text-xs text-indigo-400 hover:text-indigo-300"
            >
              Show run graph
            </button>
          )}
          {onSendMessage && (
            <button
              type="button"
              onClick={() =>
                onSendMessage(
                  runFriendlyId
                    ? `Find errors similar to the failure in run ${runFriendlyId}`
                    : "Find similar errors"
                )
              }
              className="cursor-pointer text-xs text-indigo-400 hover:text-indigo-300"
            >
              Find similar errors
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter chips — renders the structured output of `applyRunFilters`.
// ---------------------------------------------------------------------------

const FILTER_LABELS: Record<string, string> = {
  statuses: "Status",
  tasks: "Task",
  tags: "Tag",
  versions: "Version",
  queues: "Queue",
  machines: "Machine",
  sources: "Source",
  period: "Period",
  from: "From",
  to: "To",
  batchId: "Batch",
  runId: "Run",
  scheduleId: "Schedule",
};

function humanizeStatus(status: string) {
  const lower = status.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function buildChips(filters: Record<string, unknown>): string[] {
  const chips: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    if (key === "rootOnly" && value === true) {
      chips.push("Root runs only");
      continue;
    }
    const label = FILTER_LABELS[key];
    if (!label) continue;
    const display = (v: unknown) => (key === "statuses" ? humanizeStatus(String(v)) : String(v));
    if (Array.isArray(value)) {
      for (const v of value) chips.push(`${label}: ${display(v)}`);
    } else {
      chips.push(`${label}: ${display(value)}`);
    }
  }
  return chips;
}

export function FilterChips({ filters }: { filters: TaskRunListSearchFilters }) {
  const navigate = useNavigate();
  const { pageContext } = useAIChat();
  const chips = buildChips(filters as Record<string, unknown>);

  if (chips.length === 0) {
    return <div className="py-1 text-xs text-text-dimmed">No filters detected.</div>;
  }

  const applyFilters = () => {
    navigate(
      v3RunsPath(
        { slug: pageContext.organizationSlug },
        { slug: pageContext.projectSlug },
        { slug: pageContext.environmentSlug },
        filters
      )
    );
  };

  return (
    <div className="my-1">
      <div className="flex flex-wrap gap-1.5 py-1">
        {chips.map((chip, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded-full border border-charcoal-600 bg-charcoal-800/40 px-2.5 py-1 text-xs text-text-dimmed"
          >
            {chip}
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={applyFilters}
        className="mt-1 cursor-pointer text-xs text-indigo-400 underline hover:text-indigo-300"
      >
        Apply these filters →
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mini table — renders tabular output of `aggregateRuns` / `queryRuns`.
// ---------------------------------------------------------------------------

const MAX_VISIBLE_ROWS = 10;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function MiniTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: unknown[][];
}) {
  const [showAll, setShowAll] = useState(false);
  const visibleRows = showAll ? rows : rows.slice(0, MAX_VISIBLE_ROWS);
  const truncated = rows.length > MAX_VISIBLE_ROWS;

  return (
    <div className="my-1 overflow-hidden rounded-md border border-grid-bright">
      <table className="w-full border-collapse">
        <thead className="bg-charcoal-800">
          <tr>
            {columns.map((col, i) => (
              <th
                key={i}
                className="px-2.5 py-1.5 text-left text-xs font-medium text-text-dimmed"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, ri) => (
            <tr
              key={ri}
              className="animate-in fade-in slide-in-from-bottom-1 duration-100 even:bg-charcoal-800/20"
              style={{ animationDelay: `${ri * 30}ms` }}
            >
              {columns.map((_, ci) => (
                <td
                  key={ci}
                  className="break-all border-t border-grid-bright px-2.5 py-1.5 text-xs text-text-bright"
                >
                  {formatCell(row[ci])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full cursor-pointer border-t border-grid-bright px-2.5 py-1.5 text-left text-xs text-indigo-400 hover:text-indigo-300"
        >
          Show all {rows.length} rows
        </button>
      )}
    </div>
  );
}
