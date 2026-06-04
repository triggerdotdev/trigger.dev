import type { ClientData } from "./types";
import { buildToolContext } from "./types";

// Docs and navigation tools are safe to import at module load (no env.server.ts).
import { createSearchDocsTool } from "./docs/search-docs";
import { createNavigateToPageTool } from "./navigation/navigate-to-page";
import { createSearchPagesTool } from "./navigation/search-pages";
import { createGetCurrentContextTool } from "./navigation/get-current-context";

// Runs, errors, and analytics tools reach into env.server.ts, so they're loaded
// lazily to keep that out of the CLI indexing path.
async function loadServerTools() {
  const { createListRunsTool } = await import("./runs/list-runs");
  const { createGetRunDetailsTool } = await import("./runs/get-run-details");
  const { createGetSpanDetailsTool } = await import("./runs/get-span-details");
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
  const { createListTestableTasksTool } = await import("./test/list-testable-tasks");
  const { createGenerateTestPayloadTool } = await import("./test/generate-test-payload");
  const { createRunTestTaskTool } = await import("./test/run-test-task");

  return {
    createListRunsTool,
    createGetRunDetailsTool,
    createGetSpanDetailsTool,
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
    createListTestableTasksTool,
    createGenerateTestPayloadTool,
    createRunTestTaskTool,
  };
}

// Builds the tool set for a client context. Called from the agent's run() per turn.
export async function buildAssistantTools(clientData: ClientData) {
  const ctx = buildToolContext(clientData);
  const serverTools = await loadServerTools();

  return {
    // Docs
    searchDocs: createSearchDocsTool(),

    // Navigation
    navigateToPage: createNavigateToPageTool(ctx),
    searchPages: createSearchPagesTool(ctx),
    getCurrentContext: createGetCurrentContextTool(ctx),

    // Runs
    listRuns: serverTools.createListRunsTool(ctx),
    getRunDetails: serverTools.createGetRunDetailsTool(ctx),
    getSpanDetails: serverTools.createGetSpanDetailsTool(ctx),
    getRunLogs: serverTools.createGetRunLogsTool(ctx),
    getRunGraph: serverTools.createGetRunGraphTool(ctx),
    applyRunFilters: serverTools.createApplyRunFiltersTool(ctx),
    queryRuns: serverTools.createQueryRunsTool(ctx),

    // Errors
    listErrors: serverTools.createListErrorsTool(ctx),
    getErrorDetails: serverTools.createGetErrorDetailsTool(ctx),
    findSimilarErrors: serverTools.createFindSimilarErrorsTool(ctx),
    classifyFailure: serverTools.createClassifyFailureTool(ctx),

    // Analytics
    summarizeCurrentView: serverTools.createSummarizeCurrentViewTool(ctx),
    aggregateRuns: serverTools.createAggregateRunsTool(ctx),
    correlateRunsWithDeploy: serverTools.createCorrelateRunsWithDeployTool(ctx),

    // Test
    listTestableTasks: serverTools.createListTestableTasksTool(ctx),
    generateTestPayload: serverTools.createGenerateTestPayloadTool(ctx),
    runTestTask: serverTools.createRunTestTaskTool(ctx),
  };
}
