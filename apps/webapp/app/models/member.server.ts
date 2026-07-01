import type { Organization, OrgMember, Project } from "@trigger.dev/database";
import { Prisma as PrismaNamespace, type Prisma, prisma } from "~/db.server";
import { createEnvironment } from "./organization.server";
import { customAlphabet } from "nanoid";
import { logger } from "~/services/logger.server";
import { getDefaultEnvironmentConcurrencyLimit } from "~/services/platform.v3.server";
import { rbac } from "~/services/rbac.server";

export const INVITE_NOT_FOUND = "Invite not found";
export const ENV_SETUP_INCOMPLETE =
  "You joined the organization, but we couldn't finish setting up your development environments. Please try accepting the invite again, or contact support if this persists.";

export function isAcceptInviteFormError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message === INVITE_NOT_FOUND || error.message === ENV_SETUP_INCOMPLETE)
  );
}

const tokenValueLength = 40;
const tokenGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", tokenValueLength);

export async function getTeamMembersAndInvites({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}) {
  const org = await prisma.organization.findFirst({
    where: { id: organizationId, members: { some: { userId } } },
    select: {
      members: {
        select: {
          id: true,
          role: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
            },
          },
        },
      },
      invites: {
        select: {
          id: true,
          email: true,
          updatedAt: true,
          inviter: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
            },
          },
        },
      },
    },
  });

  if (!org) {
    return null;
  }

  return { members: org.members, invites: org.invites };
}

export async function removeTeamMember({
  userId,
  slug,
  memberId,
}: {
  userId: string;
  slug: string;
  memberId: string;
}) {
  const org = await prisma.organization.findFirst({
    where: { slug, members: { some: { userId } } },
  });

  if (!org) {
    throw new Error("User does not have access to this organization");
  }

  // Scope the target to this org. A member id is a globally unique key, so
  // deleting by id alone would remove members of other orgs; bind it to the
  // resolved org and reject a foreign id.
  const member = await prisma.orgMember.findFirst({
    where: { id: memberId, organizationId: org.id },
    include: {
      organization: true,
      user: true,
    },
  });

  if (!member) {
    throw new Error("Member not found in this organization");
  }

  await prisma.orgMember.delete({ where: { id: member.id } });

  return member;
}

export async function inviteMembers({
  slug,
  emails,
  userId,
  rbacRoleId,
}: {
  slug: string;
  emails: string[];
  userId: string;
  /**
   * Optional RBAC role to attach to the invite. When set, accepted
   * invites trigger `rbac.setUserRole(rbacRoleId)` after the OrgMember
   * is created.
   *
   * `OrgMemberInvite.role` is still set if the plugin isn't installed.
   */
  rbacRoleId?: string | null;
}) {
  const org = await prisma.organization.findFirst({
    where: { slug, members: { some: { userId } } },
  });

  if (!org) {
    throw new Error("User does not have access to this organization");
  }

  const invites = [...new Set(emails)].map(
    (email) =>
      ({
        email,
        token: tokenGenerator(),
        organizationId: org.id,
        inviterId: userId,
        role: "MEMBER",
        rbacRoleId: rbacRoleId ?? null,
      }) satisfies Prisma.OrgMemberInviteCreateManyInput
  );

  await prisma.orgMemberInvite.createMany({
    data: invites,
  });

  return await prisma.orgMemberInvite.findMany({
    where: {
      organizationId: org.id,
      inviterId: userId,
      email: {
        in: emails,
      },
    },
    include: {
      organization: true,
      inviter: true,
    },
  });
}

export async function getInviteFromToken({ token }: { token: string }) {
  return await prisma.orgMemberInvite.findFirst({
    where: {
      token,
    },
    include: {
      organization: true,
      inviter: true,
    },
  });
}

export async function getUsersInvites({ email }: { email: string }) {
  return await prisma.orgMemberInvite.findMany({
    where: {
      email,
      organization: {
        deletedAt: null,
      },
    },
    include: {
      organization: true,
      inviter: true,
    },
  });
}

async function getProjectsMissingMemberDevelopmentEnvironments({
  memberId,
  organizationId,
  projects,
}: {
  memberId: string;
  organizationId: string;
  projects: Pick<Project, "id">[];
}) {
  if (projects.length === 0) {
    return [];
  }

  const existingEnvs = await prisma.runtimeEnvironment.findMany({
    where: {
      orgMemberId: memberId,
      organizationId,
      type: "DEVELOPMENT",
      projectId: { in: projects.map((project) => project.id) },
    },
    select: { projectId: true },
  });
  const existingProjectIds = new Set(existingEnvs.map((env) => env.projectId));

  return projects.filter((project) => !existingProjectIds.has(project.id));
}

export async function provisionMemberDevelopmentEnvironments({
  inviteId,
  user,
  member,
  organization,
  projects,
  maximumConcurrencyLimit,
}: {
  inviteId: string;
  user: { id: string; email: string };
  member: OrgMember;
  organization: Pick<Organization, "id" | "maximumConcurrencyLimit">;
  projects: Pick<Project, "id">[];
  maximumConcurrencyLimit: number;
}) {
  const projectsNeedingEnvs = await getProjectsMissingMemberDevelopmentEnvironments({
    memberId: member.id,
    organizationId: organization.id,
    projects,
  });
  const projectIds = projects.map((project) => project.id);
  const createdProjectIds: string[] = [];
  let failedProjectId: string | undefined;
  let failedProjectIndex: number | undefined;

  try {
    for (const [index, project] of projectsNeedingEnvs.entries()) {
      failedProjectId = project.id;
      failedProjectIndex = index;

      await createEnvironment({
        organization,
        project,
        type: "DEVELOPMENT",
        // We set this true but no backfill (yet!?) so never used
        // for dev environments
        isBranchableEnvironment: true,
        member,
        maximumConcurrencyLimit,
      });

      createdProjectIds.push(project.id);
      failedProjectId = undefined;
      failedProjectIndex = undefined;
    }
  } catch (error) {
    logger.error("acceptInvite: development environment creation failed after membership created", {
      inviteId,
      userId: user.id,
      organizationId: organization.id,
      orgMemberId: member.id,
      projectIds,
      failedProjectId,
      failedProjectIndex,
      totalProjects: projectsNeedingEnvs.length,
      createdProjectIds,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    });

    throw new Error(ENV_SETUP_INCOMPLETE);
  }
}

async function assignInviteRbacRole({
  userId,
  organizationId,
  rbacRoleId,
}: {
  userId: string;
  organizationId: string;
  rbacRoleId: string;
}) {
  try {
    const roleResult = await rbac.setUserRole({
      userId,
      organizationId,
      roleId: rbacRoleId,
    });
    if (!roleResult.ok) {
      logger.error("acceptInvite: skipped RBAC role assignment", {
        organizationId,
        userId,
        rbacRoleId,
        reason: roleResult.error,
      });
    }
  } catch (error) {
    logger.error("acceptInvite: RBAC role assignment threw", {
      organizationId,
      userId,
      rbacRoleId,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    });
  }
}

async function tryRecoverIncompleteInviteAccept({
  user,
  organizationId,
  inviteId,
}: {
  user: { id: string; email: string };
  organizationId: string;
  inviteId: string;
}) {
  const member = await prisma.orgMember.findFirst({
    where: {
      userId: user.id,
      organizationId,
      organization: { deletedAt: null },
    },
    include: {
      organization: {
        include: {
          projects: { where: { deletedAt: null } },
        },
      },
    },
  });

  if (!member) {
    return null;
  }

  const missingProjects = await getProjectsMissingMemberDevelopmentEnvironments({
    memberId: member.id,
    organizationId,
    projects: member.organization.projects,
  });

  if (missingProjects.length === 0) {
    return null;
  }

  const maximumConcurrencyLimit = await getDefaultEnvironmentConcurrencyLimit(
    organizationId,
    "DEVELOPMENT"
  );

  await provisionMemberDevelopmentEnvironments({
    inviteId,
    user,
    member,
    organization: member.organization,
    projects: missingProjects,
    maximumConcurrencyLimit,
  });

  return {
    remainingInvites: await getUsersInvites({ email: user.email }),
    organization: member.organization,
  };
}

export async function acceptInvite({
  user,
  inviteId,
  organizationId,
}: {
  user: { id: string; email: string };
  inviteId: string;
  organizationId?: string;
}) {
  const invite = await prisma.orgMemberInvite.findFirst({
    where: {
      id: inviteId,
      email: user.email,
      organization: {
        deletedAt: null,
      },
    },
    include: {
      organization: {
        include: {
          projects: { where: { deletedAt: null } },
        },
      },
    },
  });

  if (!invite) {
    if (organizationId) {
      const recovered = await tryRecoverIncompleteInviteAccept({
        user,
        organizationId,
        inviteId,
      });
      if (recovered) {
        return recovered;
      }
    }
    throw new Error(INVITE_NOT_FOUND);
  }

  const maximumConcurrencyLimit = await getDefaultEnvironmentConcurrencyLimit(
    invite.organizationId,
    "DEVELOPMENT"
  );

  let member = await prisma.orgMember.findFirst({
    where: {
      organizationId: invite.organizationId,
      userId: user.id,
      organization: { deletedAt: null },
    },
  });

  if (!member) {
    try {
      member = await prisma.orgMember.create({
        data: {
          organizationId: invite.organizationId,
          userId: user.id,
          role: invite.role,
        },
      });
    } catch (error) {
      if (
        error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        member = await prisma.orgMember.findFirst({
          where: {
            organizationId: invite.organizationId,
            userId: user.id,
            organization: { deletedAt: null },
          },
        });
        if (!member) {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  await provisionMemberDevelopmentEnvironments({
    inviteId,
    user,
    member,
    organization: invite.organization,
    projects: invite.organization.projects,
    maximumConcurrencyLimit,
  });

  // Consume the invite only after development environments are provisioned so
  // a failed setup can be retried from /invites.
  try {
    await prisma.orgMemberInvite.delete({
      where: {
        id: inviteId,
        email: user.email,
      },
    });
  } catch (error) {
    if (
      !(error instanceof PrismaNamespace.PrismaClientKnownRequestError && error.code === "P2025")
    ) {
      throw error;
    }
  }

  const remainingInvites = await getUsersInvites({ email: user.email });

  // If the invite carried an explicit RBAC role, assign it. Best-effort: the
  // invite is already consumed and membership created above, so a failure here
  // — a returned {ok:false} or a thrown error from the plugin — must not block
  // joining the org. Swallow and log either way; without the catch a plugin
  // throw escapes and turns the whole invite-accept into a 400.
  if (invite.rbacRoleId) {
    await assignInviteRbacRole({
      userId: user.id,
      organizationId: invite.organization.id,
      rbacRoleId: invite.rbacRoleId,
    });
  }

  return { remainingInvites, organization: invite.organization };
}

export async function declineInvite({
  user,
  inviteId,
}: {
  user: { id: string; email: string };
  inviteId: string;
}) {
  return await prisma.$transaction(async (_tx) => {
    //1. delete invite
    const declinedInvite = await prisma.orgMemberInvite.delete({
      where: {
        id: inviteId,
        email: user.email,
      },
      include: {
        organization: true,
      },
    });

    //2. check for other invites
    const remainingInvites = await prisma.orgMemberInvite.findMany({
      where: {
        email: user.email,
      },
    });

    return { remainingInvites, organization: declinedInvite.organization };
  });
}

export async function resendInvite({ inviteId, userId }: { inviteId: string; userId: string }) {
  return await prisma.orgMemberInvite.update({
    where: {
      id: inviteId,
      inviterId: userId,
    },
    data: {
      updatedAt: new Date(),
    },
    include: {
      inviter: true,
      organization: true,
    },
  });
}

export async function revokeInvite({
  userId,
  orgSlug,
  inviteId,
}: {
  userId: string;
  orgSlug: string;
  inviteId: string;
}) {
  const invite = await prisma.orgMemberInvite.findFirst({
    where: {
      id: inviteId,
      organization: {
        slug: orgSlug,
        members: {
          some: {
            userId,
          },
        },
      },
    },
    select: {
      id: true,
      email: true,
      organization: true,
    },
  });

  if (!invite) {
    throw new Error("Invite not found");
  }

  await prisma.orgMemberInvite.delete({
    where: {
      id: invite.id,
    },
  });

  return { email: invite.email, organization: invite.organization };
}
