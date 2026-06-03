import type { ClientData } from "./types";
import { buildToolContext } from "./types";

// V1A - Docs and Navigation
import { createSearchDocsTool } from "./docs/search-docs";
import { createNavigateToPageTool } from "./navigation/navigate-to-page";
import { createSearchPagesTool } from "./navigation/search-pages";
import { createGetCurrentContextTool } from "./navigation/get-current-context";

// V1B - Runs domain
import { createListRunsTool } from "./runs/list-runs";
import { createGetRunDetailsTool } from "./runs/get-run-details";
import { createGetRunLogsTool } from "./runs/get-run-logs";
import { createGetRunGraphTool } from "./runs/get-run-graph";
import { createApplyRunFiltersTool } from "./runs/apply-run-filters";
import { createQueryRunsTool } from "./runs/query-runs";

// V1B - Errors domain
import { createListErrorsTool } from "./errors/list-errors";
import { createGetErrorDetailsTool } from "./errors/get-error-details";
import { createFindSimilarErrorsTool } from "./errors/find-similar-errors";
import { createClassifyFailureTool } from "./errors/classify-failure";

// V1B - Analytics domain
import { createSummarizeCurrentViewTool } from "./analytics/summarize-current-view";
import { createAggregateRunsTool } from "./analytics/aggregate-runs";
import { createCorrelateRunsWithDeployTool } from "./analytics/correlate-runs-with-deploy";

// Builds the tool set for a client context. Called from the agent's run() per turn.
export function buildAssistantTools(clientData: ClientData) {
  const ctx = buildToolContext(clientData);

  return {
    // V1A - Docs and Navigation
    searchDocs: createSearchDocsTool(),
    navigateToPage: createNavigateToPageTool(ctx),
    searchPages: createSearchPagesTool(ctx),
    getCurrentContext: createGetCurrentContextTool(ctx),

    // V1B - Runs
    listRuns: createListRunsTool(ctx),
    getRunDetails: createGetRunDetailsTool(ctx),
    getRunLogs: createGetRunLogsTool(ctx),
    getRunGraph: createGetRunGraphTool(ctx),
    applyRunFilters: createApplyRunFiltersTool(ctx),
    queryRuns: createQueryRunsTool(ctx),

    // V1B - Errors
    listErrors: createListErrorsTool(ctx),
    getErrorDetails: createGetErrorDetailsTool(ctx),
    findSimilarErrors: createFindSimilarErrorsTool(ctx),
    classifyFailure: createClassifyFailureTool(ctx),

    // V1B - Analytics
    summarizeCurrentView: createSummarizeCurrentViewTool(ctx),
    aggregateRuns: createAggregateRunsTool(ctx),
    correlateRunsWithDeploy: createCorrelateRunsWithDeployTool(ctx),
  };
}