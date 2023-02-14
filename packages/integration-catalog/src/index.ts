import { internalIntegration as slack } from "@trigger.dev/slack/internal";
import { internalIntegration as github } from "@trigger.dev/github/internal";
import { internalIntegration as resend } from "@trigger.dev/resend/internal";
import { internalIntegration as shopify } from "@trigger.dev/shopify/internal";
import { internalIntegration as whatsapp } from "@trigger.dev/whatsapp/internal";

import type { InternalIntegration } from "@trigger.dev/integration-sdk";

export const airtable: InternalIntegration = {
  metadata: {
    name: "Airtable",
    service: "airtable",
    icon: "/integrations/airtable.png",
    enabledFor: "admins",
    authentication: {
      type: "oauth",
      scopes: [
        "data.records:read",
        "data.records:write",
        "data.recordComments:read",
        "data.recordComments:write",
        "schema.bases:read",
        "schema.bases:write",
        "webhook:manage",
      ],
    },
  },
};

export type IntegrationCatalog = {
  integrations: Record<string, InternalIntegration>;
};

const catalog = {
  integrations: {
    airtable,
    github,
    resend,
    shopify,
    slack,
    whatsapp,
  },
};

export function getIntegration(name: string): InternalIntegration;
export function getIntegration<
  T extends keyof (typeof catalog)["integrations"]
>(name: T): InternalIntegration {
  return catalog.integrations[name];
}

export function getIntegrations(isAdmin: boolean): Array<InternalIntegration> {
  const integrations = Object.values(catalog.integrations);
  const found = integrations.filter((integration) => {
    switch (integration.metadata.enabledFor) {
      case "all":
        return true;
      case "admins":
        return isAdmin;
      case "none":
        return false;
      default:
        return false;
    }
  }) as InternalIntegration[];

  return found;
}
