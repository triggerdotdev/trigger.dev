import { tryCatch } from "@trigger.dev/core";
import type { CardVerification } from "~/services/cardVerification.schemas";
import { logger } from "~/services/logger.server";
import { getCardVerification } from "~/services/platform.v3.server";
import { freeCardStepPath, type FreeCardReturnTo } from "~/components/billing/freeCardStepPath";
import { newProjectPath, v3BillingPath, type OrgForPath } from "~/utils/pathBuilder";
import {
  cardVerificationGateConfig,
  hasActiveDeployAccessOverride,
  isInCardVerificationCohort,
  readGatePlanType,
  type CardVerificationGateConfig,
  type GatePlanType,
} from "~/v3/cardVerificationGate.server";

export { freeCardStepPath };

export type FreeCardStepDependencies = {
  getCardVerification(organizationId: string): Promise<CardVerification | null>;
  gateConfig(): CardVerificationGateConfig;
  planType(organizationId: string): Promise<GatePlanType>;
  hasActiveOverride(organizationId: string): Promise<boolean>;
};

const defaultDependencies: FreeCardStepDependencies = {
  getCardVerification,
  gateConfig: cardVerificationGateConfig,
  planType: readGatePlanType,
  hasActiveOverride: hasActiveDeployAccessOverride,
};

/**
 * The card step only makes sense where the gate would switch deploys off without a card: in the
 * cohort, on the Free plan, without an unexpired deploy access override, billed where cards are
 * verified, and without one yet. A lookup that fails skips the step, so it never stands between an org and its project.
 */
export async function needsCardStep(
  organization: { id: string; createdAt: Date },
  deps: FreeCardStepDependencies = defaultDependencies
): Promise<boolean> {
  if (!isInCardVerificationCohort(deps.gateConfig(), organization.createdAt)) return false;

  // A paid org's invoice card comes from its own checkout.
  const [planError, plan] = await tryCatch(deps.planType(organization.id));
  if (planError || plan !== "free") return false;

  const [overrideError, overridden] = await tryCatch(deps.hasActiveOverride(organization.id));
  if (overrideError) {
    logger.error("Card step could not read the deploy access override", {
      organizationId: organization.id,
      error: overrideError.message,
    });
    return false;
  }
  if (overridden) return false;

  const verification = await deps.getCardVerification(organization.id);
  return verification?.supported === true && !verification.verified;
}

export type FreeCardOutcome = "complete" | "canceled" | "failed";

const FAILURE_MESSAGES: Record<string, string> = {
  card_not_verified: "Your bank didn't verify that card. Please try another one.",
};

/** Where the card step hands over once the card is verified or skipped. */
export function freeCardDonePath(organization: OrgForPath, returnTo?: FreeCardReturnTo) {
  return returnTo === "billing" ? v3BillingPath(organization) : newProjectPath(organization);
}

/** Where the user lands after Stripe's card page, and the toast they see. */
export function freeCardOutcomeRedirect(
  organization: OrgForPath,
  outcome: FreeCardOutcome,
  reason: string | null,
  returnTo?: FreeCardReturnTo
): { path: string; kind: "success" | "error"; message: string } {
  if (outcome === "complete") {
    return {
      path: freeCardDonePath(organization, returnTo),
      kind: "success",
      message: "Card verified. You can deploy and run tasks on Trigger.dev Cloud.",
    };
  }
  if (outcome === "canceled") {
    return {
      path: freeCardStepPath(organization, returnTo),
      kind: "error",
      message: "You didn't add a card. Add one now, or skip to use local dev only.",
    };
  }
  // The reason comes from the URL, so only known reasons pick the message.
  return {
    path: freeCardStepPath(organization, returnTo),
    kind: "error",
    message:
      (reason ? FAILURE_MESSAGES[reason] : undefined) ??
      "We couldn't verify your card. Please try again.",
  };
}

function isFreePlanProvisioned(response: Response, organization: OrgForPath) {
  return response.headers.get("Location")?.startsWith(newProjectPath(organization)) ?? false;
}

/**
 * Picking Free sends the org on to project creation. An org that needs the card step goes there
 * instead. Cookies already set on the response are kept.
 */
export async function routeFreePlanToCardStep(
  response: Response,
  organization: OrgForPath & { id: string; createdAt: Date },
  deps: FreeCardStepDependencies = defaultDependencies
): Promise<Response> {
  if (!isFreePlanProvisioned(response, organization)) return response;
  if (!(await needsCardStep(organization, deps))) return response;

  response.headers.set("Location", freeCardStepPath(organization));
  return response;
}
