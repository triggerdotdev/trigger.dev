import type { ClientData } from "./types";
import { buildToolContext } from "./types";
import { createSearchDocsTool } from "./docs/search-docs";
import { createNavigateToPageTool } from "./navigation/navigate-to-page";
import { createSearchPagesTool } from "./navigation/search-pages";
import { createGetCurrentContextTool } from "./navigation/get-current-context";

// Builds the tool set for a client context. Called from the agent's run() per turn.
export function buildAssistantTools(clientData: ClientData) {
  const ctx = buildToolContext(clientData);

  return {
    searchDocs: createSearchDocsTool(),
    navigateToPage: createNavigateToPageTool(ctx),
    searchPages: createSearchPagesTool(ctx),
    getCurrentContext: createGetCurrentContextTool(ctx),
  };
}