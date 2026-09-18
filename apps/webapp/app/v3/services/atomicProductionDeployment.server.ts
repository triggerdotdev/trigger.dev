import { type PrismaClient, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";

/** A standalone task build cannot complete Vercel's coordinated production release. */
export async function atomicProductionDeploymentUrl(
  projectId: string,
  environmentType: RuntimeEnvironmentType,
  client: PrismaClient = prisma
): Promise<string | undefined> {
  if (environmentType !== "PRODUCTION") return;
  const integration = await new VercelIntegrationService(client).getVercelProjectIntegration(
    projectId
  );
  if (!integration?.parsedIntegrationData.config.atomicBuilds?.includes("prod")) return;

  const { vercelTeamSlug, vercelProjectName } = integration.parsedIntegrationData;
  return vercelTeamSlug && vercelProjectName
    ? `https://vercel.com/${encodeURIComponent(vercelTeamSlug)}/${encodeURIComponent(vercelProjectName)}`
    : "https://vercel.com/dashboard";
}
