import { GitMeta, needsNodeRuntimeUpdate } from "@trigger.dev/core/v3";
import type { PrismaClientOrTransaction, WorkerDeployment } from "@trigger.dev/database";
import { env } from "~/env.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";
import { scheduleEmail } from "~/services/scheduleEmail.server";

export async function scheduleNodeRuntimeDeprecationEmail({
  prisma,
  deployment,
  environment,
  runtime,
  runtimeVersion,
}: {
  prisma: PrismaClientOrTransaction;
  deployment: WorkerDeployment;
  environment: AuthenticatedEnvironment;
  runtime: string | null | undefined;
  runtimeVersion: string | null | undefined;
}) {
  if (!needsNodeRuntimeUpdate(runtime, runtimeVersion)) {
    return;
  }

  try {
    const recipients = await resolveRecipients(prisma, deployment, environment);

    if (recipients.length === 0) {
      logger.warn("No recipient found for Node.js runtime deprecation email", {
        deploymentId: deployment.id,
        environmentId: environment.id,
        projectId: environment.projectId,
      });
      return;
    }

    for (const recipient of recipients) {
      try {
        await scheduleEmail({
          email: "node-runtime-deprecation",
          to: recipient,
          organization: environment.organization.title,
          project: environment.project.name,
          environment: environment.slug,
          version: deployment.version,
          runtimeVersion: runtimeVersion ?? "21",
          deploymentLink: `${env.APP_ORIGIN}/projects/v3/${environment.project.externalRef}/deployments/${deployment.shortCode}`,
          projectsLink: `${env.APP_ORIGIN}/orgs/${encodeURIComponent(environment.organization.slug)}/settings/projects`,
        });
      } catch (error) {
        logger.error("Failed to enqueue Node.js runtime deprecation email", {
          error,
          recipient,
          deploymentId: deployment.id,
        });
      }
    }
  } catch (error) {
    logger.error("Failed to schedule Node.js runtime deprecation email", {
      error,
      deploymentId: deployment.id,
      environmentId: environment.id,
      projectId: environment.projectId,
    });
  }
}

async function resolveRecipients(
  prisma: PrismaClientOrTransaction,
  deployment: WorkerDeployment,
  environment: AuthenticatedEnvironment
): Promise<string[]> {
  if (deployment.triggeredById) {
    const triggeredBy = await findOrganizationMemberEmail(
      prisma,
      deployment.triggeredById,
      environment.organizationId
    );

    if (triggeredBy) {
      return [triggeredBy];
    }
  }

  const git = GitMeta.safeParse(deployment.git);
  if (git.success && git.data.source === "trigger_github_app") {
    const connection = await prisma.connectedGithubRepository.findFirst({
      where: { projectId: environment.projectId },
      select: {
        repository: {
          select: {
            installation: {
              select: { installedByUserId: true },
            },
          },
        },
      },
    });
    const installedByUserId = connection?.repository.installation.installedByUserId;
    const installedBy = installedByUserId
      ? await findOrganizationMemberEmail(prisma, installedByUserId, environment.organizationId)
      : undefined;

    if (installedBy) {
      return [installedBy];
    }
  }

  const members = await prisma.orgMember.findMany({
    where: { organizationId: environment.organizationId },
    select: {
      role: true,
      userId: true,
      user: { select: { email: true } },
    },
  });
  const roles = await rbac.getUserRoles(
    members.map((member) => member.userId),
    environment.organizationId
  );
  const adminEmails = members.flatMap((member) => {
    const role = roles.get(member.userId);
    const hasEffectiveAdminRole =
      role?.isSystem === true && (role.name === "Owner" || role.name === "Admin");
    const isFallbackAdmin = role === null && member.role === "ADMIN";

    return hasEffectiveAdminRole || isFallbackAdmin ? [member.user.email] : [];
  });

  return [...new Set(adminEmails)];
}

async function findOrganizationMemberEmail(
  prisma: PrismaClientOrTransaction,
  userId: string,
  organizationId: string
) {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      orgMemberships: { some: { organizationId } },
    },
    select: { email: true },
  });

  return user?.email;
}
