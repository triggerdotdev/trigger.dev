import { type PrismaClient, type WorkerDeploymentStatus } from "@trigger.dev/database";
import { createTestOrgProjectWithMember, uniqueId } from "./environmentVariablesFixtures";
export const archiveTestNow = new Date("2026-09-16T12:00:00Z");
export const archiveTestOld = new Date(archiveTestNow.getTime() - 20 * 24 * 60 * 60 * 1000);
const now = archiveTestNow;
const old = archiveTestOld;
export async function seedPreviewArchive(prisma: PrismaClient, rolloutEnabled = true) {
  const { project, organization } = await createTestOrgProjectWithMember(prisma);
  if (rolloutEnabled) {
    await prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { previewAutoArchiveEnabled: true } },
    });
  }
  const base = { projectId: project.id, organizationId: organization.id, type: "PREVIEW" as const };
  const parent = await prisma.runtimeEnvironment.create({
    data: {
      ...base,
      slug: "preview",
      shortcode: "preview",
      apiKey: uniqueId("api"),
      pkApiKey: uniqueId("pk"),
      isBranchableEnvironment: true,
      previewAutoArchiveAfterDays: 14,
      previewAutoArchiveNextCheckAt: now,
      previewAutoArchiveExcludedBranches: ["staging"],
    },
  });
  const branch = async (name = uniqueId("branch"), createdAt = old) =>
    prisma.runtimeEnvironment.create({
      data: {
        ...base,
        slug: `preview-${name}`,
        shortcode: `preview-${name}`,
        apiKey: uniqueId("api"),
        pkApiKey: uniqueId("pk"),
        branchName: name,
        parentEnvironmentId: parent.id,
        createdAt,
      },
    });
  const deployment = async (
    environmentId: string,
    createdAt: Date,
    status: WorkerDeploymentStatus = "DEPLOYED"
  ) =>
    prisma.workerDeployment.create({
      data: {
        environmentId,
        projectId: project.id,
        createdAt,
        status,
        version: uniqueId("version"),
        friendlyId: uniqueId("deployment"),
        shortCode: uniqueId("short"),
        contentHash: "hash",
      },
    });
  const deployData = () => ({
    projectId: project.id,
    friendlyId: uniqueId("deployment"),
    shortCode: uniqueId("short"),
    contentHash: "hash",
  });
  return { parent, branch, deployment, deployData, project, organization };
}
