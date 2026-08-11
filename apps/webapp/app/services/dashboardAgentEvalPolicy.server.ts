/**
 * Whether an org's agent turns may be judged. The agent has no main-database access, so it
 * asks the API for this and treats anything but an explicit yes as no.
 */

import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG, hasUnreadableTurnEvalsOverride } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

/** Judging is on unless an org turns it off. */
const DEFAULT_TURN_EVALS_ENABLED = true;

/**
 * Resolves `dashboardAgentTurnEvalsEnabled` for one org, with a per-org override winning in
 * both directions. Membership-scoped: a token can name any org, so the caller's membership
 * is the tenant floor. Returns false when the org (or its setting) can't be read — a judged
 * turn goes to a third-party model, so an unknown answer must not read as consent.
 */
export async function orgAllowsDashboardAgentTurnEvals(params: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  try {
    const org = await prisma.organization.findFirst({
      where: {
        id: params.organizationId,
        members: { some: { userId: params.userId } },
      },
      select: { featureFlags: true },
    });
    if (!org) return false;

    const overrides = (org.featureFlags as Record<string, unknown>) ?? {};
    // `flag()` ignores an override the schema rejects and falls through to the global default,
    // which is on — so an org that tried to turn judging off would keep being judged.
    if (hasUnreadableTurnEvalsOverride(overrides)) return false;

    const flag = makeFlag();
    return Boolean(
      await flag({
        key: FEATURE_FLAG.dashboardAgentTurnEvalsEnabled,
        defaultValue: DEFAULT_TURN_EVALS_ENABLED,
        overrides,
      })
    );
  } catch (error) {
    logger.error("Couldn't read the org's dashboard agent turn-eval setting", {
      organizationId: params.organizationId,
      error,
    });
    return false;
  }
}
