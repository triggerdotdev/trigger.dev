import type { ClientData } from "./types";
import { buildToolContext } from "./types";

// V1A - Docs and Navigation (always safe to import)
import { createSearchDocsTool } from "./docs/search-docs";
import { createNavigateToPageTool } from "./navigation/navigate-to-page";
import { createSearchPagesTool } from "./navigation/search-pages";
import { createGetCurrentContextTool } from "./navigation/get-current-context";

// V1B tools are lazy-loaded to avoid env.server.ts at CLI indexing time
async function loadV1BTools() {
  const { createListRunsTool } = await import("./runs/list-runs");
  const { createGetRunDetailsTool } = await import("./runs/get-run-details");
  const { createGetRunLogsTool } = await import("./runs/get-run-logs");
  const { createGetRunGraphTool } = await import("./runs/get-run-graph");
  const { createApplyRunFiltersTool } = await import("./runs/apply-run-filters");
  const { createQueryRunsTool } = await import("./runs/query-runs");
  const { createListErrorsTool } = await import("./errors/list-errors");
  const { createGetErrorDetailsTool } = await import("./errors/get-error-details");
  const { createFindSimilarErrorsTool } = await import("./errors/find-similar-errors");
  const { createClassifyFailureTool } = await import("./errors/classify-failure");
  const { createSummarizeCurrentViewTool } = await import("./analytics/summarize-current-view");
  const { createAggregateRunsTool } = await import("./analytics/aggregate-runs");
  const { createCorrelateRunsWithDeployTool } = await import("./analytics/correlate-runs-with-deploy");

  return {
    createListRunsTool,
    createGetRunDetailsTool,
    createGetRunLogsTool,
    createGetRunGraphTool,
    createApplyRunFiltersTool,
    createQueryRunsTool,
    createListErrorsTool,
    createGetErrorDetailsTool,
    createFindSimilarErrorsTool,
    createClassifyFailureTool,
    createSummarizeCurrentViewTool,
    createAggregateRunsTool,
    createCorrelateRunsWithDeployTool,
  };
}

// Builds the tool set for a client context. Called from the agent's run() per turn.
export async function buildAssistantTools(clientData: ClientData) {
  const ctx = buildToolContext(clientData);

  // V1A tools are always available
  const v1aTools = {
    searchDocs: createSearchDocsTool(),
    navigateToPage: createNavigateToPageTool(ctx),
    searchPages: createSearchPagesTool(ctx),
    getCurrentContext: createGetCurrentContextTool(ctx),
  };

  // V1B tools are lazy-loaded
  const v1bTools = await loadV1BTools();

  return {
    // V1A - Docs and Navigation
    ...v1aTools,

    // V1B - Runs
    listRuns: v1bTools.createListRunsTool(ctx),
    getRunDetails: v1bTools.createGetRunDetailsTool(ctx),
    getRunLogs: v1bTools.createGetRunLogsTool(ctx),
    getRunGraph: v1bTools.createGetRunGraphTool(ctx),
    applyRunFilters: v1bTools.createApplyRunFiltersTool(ctx),
    queryRuns: v1bTools.createQueryRunsTool(ctx),

    // V1B - Errors
    listErrors: v1bTools.createListErrorsTool(ctx),
    getErrorDetails: v1bTools.createGetErrorDetailsTool(ctx),
    findSimilarErrors: v1bTools.createFindSimilarErrorsTool(ctx),
    classifyFailure: v1bTools.createClassifyFailureTool(ctx),

    // V1B - Analytics
    summarizeCurrentView: v1bTools.createSummarizeCurrentViewTool(ctx),
    aggregateRuns: v1bTools.createAggregateRunsTool(ctx),
    correlateRunsWithDeploy: v1bTools.createCorrelateRunsWithDeployTool(ctx),
  };
}