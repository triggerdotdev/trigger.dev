import type { ToolSet } from "ai";
import { buildRepoTools } from "./repo-tools";
import { buildAlertTools } from "./tool-alerts";
import { buildApiTools } from "./tool-api";
import { createApiClient } from "./tool-api-client";
import { createInvestigationRenderer } from "./tool-investigations";
import { buildNavigationTools } from "./tool-navigation";
import { createSourceReadLedger } from "./tool-source-ledger";
import { buildWatchTools } from "./watch-tools";
import type { DashboardAgentToolContext } from "./tool-context";

export type { DashboardAgentToolContext } from "./tool-context";
export { showCodeAskPrompt } from "./tool-investigations";

/**
 * Assembles the ready adapters into one tool set. The key order below is frozen:
 * `dashboardAgentToolSchemas` is the canonical order the cached prompt prefix is built
 * from, and reordering these spreads is a different prefix.
 */

// Always returns the same tool set, so it stays stable while the SDK replays it over
// prior history. With no delegated token each tool reports that instead of disappearing.
export function buildDashboardAgentTools(ctx: DashboardAgentToolContext): ToolSet {
  const client = createApiClient(ctx);
  const ledger = createSourceReadLedger({
    origin: client.origin,
    hasAuth: client.hasAuth,
    userActorToken: ctx.userActorToken,
    projectRef: ctx.projectRef,
    environmentName: ctx.environmentName,
    environmentBranch: ctx.environmentBranch,
    repoSnapshot: ctx.repoSnapshot,
  });
  const renderInvestigations = createInvestigationRenderer({
    projectRef: ctx.projectRef,
    environmentId: ctx.environmentId,
    investigations: ctx.investigations,
    reads: ledger,
  });

  const apiTools: ToolSet = {
    ...buildApiTools({ ctx, client, renderInvestigations }),
    ...buildNavigationTools(ctx),
    ...buildWatchTools(),
    ...buildAlertTools({ ctx, client }),
  };

  // Code mode: when the project has a connected repo, add the source tools.
  if (!ctx.repoSnapshot) return apiTools;
  return {
    ...apiTools,
    ...ledger.withReadTracking(buildRepoTools(ctx.repoSnapshot, ledger.resolveRunSnapshot)),
  };
}
