import type { Prisma } from "@trigger.dev/database";
import { env } from "~/env.server";
import { v3WebhookEndpointPath } from "~/utils/pathBuilder";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import { mcpEnvironmentName, renderWebhookSetupPrompt } from "./webhookSetupPrompt";

export const webhookSetupPromptSelect = {
  friendlyId: true,
  opaqueId: true,
  declaredId: true,
  source: true,
  secretProvisioning: true,
  signingSecretKey: true,
  setupPrompt: true,
  endpointTenantId: true,
  routingTargets: true,
  verifierArtifact: true,
} satisfies Prisma.WebhookEndpointSelect;

type SetupPromptRow = Prisma.WebhookEndpointGetPayload<{ select: typeof webhookSetupPromptSelect }>;

type SetupPromptEnvironment = {
  slug: string;
  type: string;
  branchName: string | null;
  project: { slug: string; externalRef: string };
  organization: { slug: string };
};

export function buildWebhookSetupPrompt(
  endpoint: SetupPromptRow,
  environment: SetupPromptEnvironment
): string {
  return renderWebhookSetupPrompt(
    {
      friendlyId: endpoint.friendlyId,
      declaredId: endpoint.declaredId,
      source: endpoint.source,
      secretProvisioning: endpoint.secretProvisioning,
      hasSigningSecret: endpoint.signingSecretKey != null && endpoint.signingSecretKey !== "",
      setupPrompt: endpoint.setupPrompt,
      tenantId: endpoint.endpointTenantId || null,
      routingTargets: endpoint.routingTargets,
      verifierArtifact: endpoint.verifierArtifact,
    },
    {
      webhookUrl: webhookIngressUrl(endpoint.opaqueId),
      apiOrigin: env.API_ORIGIN ?? env.APP_ORIGIN,
      dashboardUrl: `${env.APP_ORIGIN}${v3WebhookEndpointPath(
        environment.organization,
        environment.project,
        environment,
        endpoint.friendlyId
      )}`,
      projectRef: environment.project.externalRef,
      environment: mcpEnvironmentName(environment.type),
      branch: environment.branchName ?? undefined,
    }
  );
}
