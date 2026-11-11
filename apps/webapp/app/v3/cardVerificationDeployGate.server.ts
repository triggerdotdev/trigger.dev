import { freeCardStepPath } from "~/components/billing/freeCardStepPath";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import {
  resolveCardVerificationGate,
  type CardVerificationGate,
} from "./cardVerificationGate.server";

type GatedOrganization = { id: string; slug: string; title: string };

export type CardVerificationDeployGateDependencies = {
  resolveGate?: (organizationId: string) => Promise<CardVerificationGate>;
  appOrigin?: string;
  log?: Pick<typeof logger, "error">;
};

function cardVerificationRequiredMessage(
  organization: Pick<GatedOrganization, "slug" | "title">,
  appOrigin: string = env.APP_ORIGIN
): string {
  return [
    "Unlock your Free tier credits to deploy.",
    `“${organization.title}” needs a card on file to use its free credits for deployments. It’s a verification check only, so you won’t be charged.`,
    `Add a card: ${appOrigin}${freeCardStepPath(organization)}`,
  ].join("\n");
}

/**
 * The refusal message when the org's deploys wait on a verified card, otherwise undefined.
 * Fails open when billing can't be read, so a billing outage never blocks paying orgs.
 */
export async function cardVerificationDeployRefusal(
  organization: GatedOrganization,
  {
    resolveGate = resolveCardVerificationGate,
    appOrigin = env.APP_ORIGIN,
    log = logger,
  }: CardVerificationDeployGateDependencies = {}
): Promise<string | undefined> {
  const gate = await resolveGate(organization.id);
  if (gate === "gated") return cardVerificationRequiredMessage(organization, appOrigin);
  if (gate === "unknown") {
    log.error("Card verification gate unknown, letting the deploy through", {
      organizationId: organization.id,
    });
  }
  return undefined;
}
