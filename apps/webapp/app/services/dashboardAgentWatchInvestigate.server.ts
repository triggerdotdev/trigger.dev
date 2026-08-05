/**
 * The second half of a consented watch: making the agent conduct the investigation its
 * wake said had started. The wake turn carries no delegated token, since it narrates
 * what the check already established rather than reading, so the reading turn is kicked
 * from here, where a token can be minted.
 *
 * Security, all decided here and none of it model-suppliable:
 * - the token is for `watch.userId`, minted against `watch.environmentId`, the immutable
 *   snapshot the watch was created with, never anything from a request body;
 * - the caller re-authorizes that user against that environment first, so a revoked
 *   access investigates nothing;
 * - the TTL is the same short one every turn's token gets;
 * - the token is never logged and never reaches a browser.
 */

import type { WatchInvestigateAction } from "@internal/dashboard-agent";
import { type Watch } from "@internal/dashboard-agent-db";
import { watchResultNeedsAttention } from "@internal/dashboard-agent-contracts";
import { ApiClient } from "@trigger.dev/core/v3";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  dashboardAgentApiOrigin,
  dashboardAgentEnvironmentName,
  mintDashboardAgentUserActorToken,
} from "~/services/dashboardAgent.server";
import { env } from "~/env.server";

/**
 * Whether this resolved watch is one the consent covers.
 *
 * Consent is for attention outcomes only, and the contracts' mapping decides which those
 * are. It is the same call the agent's wake makes, so the two can't disagree about what
 * counts as bad news. A watch with no resolution has no outcome to investigate.
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

/**
 * The action the agent receives. Stable id, so a retried kick is a no-op. Typed against
 * the agent's own contract, type-only so the agent's runtime never enters this bundle.
 */
export function watchInvestigateAction(watch: Watch): WatchInvestigateAction {
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
 * Send the kick. Throws on failure, and every caller treats it as best-effort: the wake
 * has already been delivered by the time we get here and nothing about this may retry or
 * invalidate it. A turn that dies mid-investigation is covered by the
 * stale-investigation sweep.
 */
export async function kickWatchInvestigation(params: {
  watch: Watch;
  environment: AuthenticatedEnvironment;
}): Promise<void> {
  const { watch, environment } = params;
  const accessToken = env.DASHBOARD_AGENT_SECRET_KEY;
  if (!accessToken) throw new Error("DASHBOARD_AGENT_SECRET_KEY is not set");

  const apiOrigin = dashboardAgentApiOrigin();
  // The agent's `clientData` for this record: the watch's immutable tenancy plus the
  // delegated token, which is what turns this into a turn that can read.
  const metadata = {
    userId: watch.userId,
    organizationId: watch.organizationId,
    projectId: watch.projectId,
    environmentId: watch.environmentId,
    projectRef: watch.projectRef ?? environment.project.externalRef,
    environmentName: dashboardAgentEnvironmentName(environment.type),
    apiOrigin,
    userActorToken: await mintDashboardAgentUserActorToken(watch.userId, {
      environmentId: watch.environmentId,
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
