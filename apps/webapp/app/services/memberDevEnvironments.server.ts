import { z } from "zod";
import { prisma } from "~/db.server";
import {
  getProjectsMissingMemberDevelopmentEnvironments,
  MembershipSourceSchema,
  provisionMemberDevelopmentEnvironments,
  type MembershipSource,
} from "~/models/member.server";
import { logger } from "~/services/logger.server";
import { getDefaultEnvironmentConcurrencyLimit } from "~/services/platform.v3.server";

export const MembershipDevEnvironmentsSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  source: MembershipSourceSchema,
});

export type MembershipDevEnvironments = z.infer<typeof MembershipDevEnvironmentsSchema>;

/**
 * Create the member's missing development environments, one per active project.
 * Idempotent, so it is safe to re-run and to retry after a partial failure.
 */
export async function provisionDevEnvironmentsForMembership({
  userId,
  organizationId,
  source,
}: MembershipDevEnvironments): Promise<void> {
  const member = await prisma.orgMember.findFirst({
    where: {
      userId,
      organizationId,
      organization: { deletedAt: null },
    },
    include: {
      organization: {
        include: {
          projects: { where: { deletedAt: null }, select: { id: true } },
        },
      },
    },
  });

  if (!member) {
    logger.info("provisionDevEnvironmentsForMembership: no membership found", {
      userId,
      organizationId,
      source,
    });
    return;
  }

  const projectsNeedingEnvs = await getProjectsMissingMemberDevelopmentEnvironments({
    memberId: member.id,
    organizationId,
    projects: member.organization.projects,
  });

  if (projectsNeedingEnvs.length === 0) {
    return;
  }

  const maximumConcurrencyLimit = await getDefaultEnvironmentConcurrencyLimit(
    organizationId,
    "DEVELOPMENT"
  );

  await provisionMemberDevelopmentEnvironments({
    source,
    member,
    organization: member.organization,
    projects: projectsNeedingEnvs,
    maximumConcurrencyLimit,
  });
}

/**
 * Queue provisioning, deduped per membership. Never throws: callers decide what
 * `enqueued: false` means for them.
 */
export async function enqueueMemberDevelopmentEnvironments(payload: {
  userId: string;
  organizationId: string;
  source: MembershipSource;
}): Promise<{ enqueued: boolean }> {
  try {
    // Lazy: a static import would close a module cycle.
    const { commonWorker } = await import("~/v3/commonWorker.server");

    await commonWorker.enqueueOnce({
      id: `membership:devEnvs:${payload.organizationId}:${payload.userId}`,
      job: "membership.provisionDevEnvironments",
      payload,
    });

    return { enqueued: true };
  } catch (error) {
    logger.error("Failed to enqueue member development environment provisioning", {
      ...payload,
      error: error instanceof Error ? error.message : String(error),
    });

    return { enqueued: false };
  }
}
