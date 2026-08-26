/**
 * The reading turn of a consented watch, kicked from here because the wake turn has no token.
 * The token is for `watch.userId` against `watch.environmentId`, off the row, never a body.
 */

import type { WatchInvestigateAction } from "@internal/dashboard-agent";
import { type Watch } from "@internal/dashboard-agent-db";
import { watchResultNeedsAttention } from "@internal/dashboard-agent-contracts";
import { ApiClient } from "@trigger.dev/core/v3";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  dashboardAgentApiOrigin,
  dashboardAgentUserApiOrigin,
  mintDashboardAgentUserActorToken,
} from "~/services/dashboardAgent.server";
import { dashboardAgentEnvironmentAddress } from "~/services/dashboardAgentEnvironmentAddress.server";
import { env } from "~/env.server";

/**
 * Whether the consent covers this resolved watch. The same contracts call the agent's wake
 * makes, so the two can't disagree about which outcomes need attention.
 */
export function watchWantsInvestigation(watch: Watch): boolean {
  if (!watch.investigateOnAttention) return false;
  if (!watch.resolution) return false;
  return watchResultNeedsAttention({
    kind: watch.spec.kind,
    resolution: watch.resolution,
    outcome: watch.observedOutcome,
  });
}

/** The action the agent receives. Stable id, so a retried kick is a no-op. */
function watchInvestigateAction(watch: Watch): WatchInvestigateAction {
  return {
    type: "watch.investigate" as const,
    id: `watch:${watch.id}:${watch.status}:investigate`,
    watchId: watch.id,
    identity: watch.identity,
    spec: watch.spec,
    facts: (watch.lastResult ?? {}) as Record<string, unknown>,
    resolution: watch.resolution ?? undefined,
    observed: watch.observedOutcome ?? undefined,
    note: watch.spec.note,
  };
}

/**
 * Send the kick. Throws on failure, and every caller treats it as best-effort: the wake is
 * already delivered, so nothing here may retry or invalidate it.
 */
export async function kickWatchInvestigation(params: {
  watch: Watch;
  environment: AuthenticatedEnvironment;
}): Promise<void> {
  const { watch, environment } = params;
  const accessToken = env.DASHBOARD_AGENT_SECRET_KEY;
  if (!accessToken) throw new Error("DASHBOARD_AGENT_SECRET_KEY is not set");

  const apiOrigin = dashboardAgentApiOrigin();
  const userApiOrigin = dashboardAgentUserApiOrigin();
  // The watch's immutable tenancy plus the delegated token that lets the turn read.
  const metadata = {
    userId: watch.userId,
    organizationId: watch.organizationId,
    projectId: watch.projectId,
    environmentId: watch.environmentId,
    projectRef: watch.projectRef ?? environment.project.externalRef,
    ...dashboardAgentEnvironmentAddress(environment),
    apiOrigin: userApiOrigin,
    userActorToken: await mintDashboardAgentUserActorToken(watch.userId, {
      environmentId: watch.environmentId,
      organizationId: watch.organizationId,
    }),
  };

  const apiClient = new ApiClient(apiOrigin, accessToken);
  await apiClient.appendToSessionStream(
    // Sessions are addressable by externalId, which is the chat id.
    watch.chatId,
    "in",
    JSON.stringify({
      kind: "message",
      payload: {
        chatId: watch.chatId,
        trigger: "action",
        action: watchInvestigateAction(watch),
        metadata,
      },
    })
  );
}
