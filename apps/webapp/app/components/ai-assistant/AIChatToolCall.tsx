import { Spinner } from "~/components/primitives/Spinner";

const TOOL_LABELS: Record<string, string> = {
  // V1A - Docs and Navigation
  searchDocs: "Searching documentation…",
  navigateToPage: "Finding page…",
  getCurrentContext: "Checking context…",
  searchPages: "Searching pages…",

  // V1B - Runs
  listRuns: "Querying runs…",
  getRunDetails: "Loading run details…",
  getRunLogs: "Fetching logs…",
  getRunGraph: "Building run graph…",
  applyRunFilters: "Building filters…",
  queryRuns: "Running analytics query…",

  // V1B - Errors
  listErrors: "Loading error groups…",
  getErrorDetails: "Loading error details…",
  findSimilarErrors: "Searching error history…",
  classifyFailure: "Classifying failure…",

  // V1B - Analytics
  summarizeCurrentView: "Analyzing current view…",
  aggregateRuns: "Computing aggregations…",
  correlateRunsWithDeploy: "Checking deploy correlation…",
};

interface AIChatToolCallProps {
  toolName: string;
  state: string;
}

export function AIChatToolCall({ toolName, state }: AIChatToolCallProps) {
  const label = TOOL_LABELS[toolName] ?? `Running ${toolName}…`;
  const isRunning = state === "input-streaming" || state === "input-available";

  if (!isRunning) return null;

  return (
    <div className="flex items-center gap-2 py-2 text-xs text-text-dimmed">
      <Spinner
        className="size-3.5"
        color={{ background: "rgba(99, 102, 241, 1)", foreground: "rgba(217, 70, 239, 1)" }}
      />
      <span>{label}</span>
    </div>
  );
}