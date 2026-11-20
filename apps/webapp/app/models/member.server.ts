import type {
  Organization,
  OrgMember,
  PrismaClientOrTransaction,
  Project,
} from "@trigger.dev/database";
import { tryCatch } from "@trigger.dev/core/utils";
import { z } from "zod";
import { Prisma as PrismaNamespace, type Prisma, prisma } from "~/db.server";
import {
  createDevelopmentEnvironmentForMember,
  memberDevelopmentEnvironmentWhere,
} from "./organization.server";
import { customAlphabet } from "nanoid";
import { isOrganizationJoinAllowed } from "~/services/accessPolicy.server";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import { userActor } from "~/services/credentialFingerprints.server";
import { enqueueAttioMemberSync } from "~/services/attio.server";
import { logger } from "~/services/logger.server";
import { getDefaultEnvironmentConcurrencyLimit } from "~/services/platform.v3.server";
import { rbac } from "~/services/rbac.server";
import { ssoController } from "~/services/sso.server";
import {
  auditRoleName,
  inviteAuditTarget,
  memberAuditTarget,
  recordMemberAuditEventInBackground,
} from "./memberAudit.server";

import { boundedIn } from "@trigger.dev/database";
export const INVITE_NOT_FOUND = "Invite not found";
const INVITE_BLOCKED_DIRECTORY_MANAGED =
  "Membership for this organization is managed by Directory Sync, so invites can't be accepted.";
export const ENV_SETUP_INCOMPLETE =
  "You joined the organization, but we couldn't finish setting up your development environments. Please try accepting the invite again, or contact support if this persists.";

/** How a membership came to exist. Also validates the queued job's payload. */
export const MembershipSourceSchema = z.enum(["invite", "sso_jit", "directory_sync", "manual"]);

export type MembershipSource = z.infer<typeof MembershipSourceSchema>;

// Stored on OrgMember.joinMethod. "created" = the member who created the organization.
export type OrgMemberJoinMethod = "created" | MembershipSource;

/** Thrown when provisioning fails partway through; the membership is still valid. */
export class DevEnvironmentProvisioningError extends Error {
  readonly logLevel = "warn" as const;

  constructor(
    message: string,
    readonly context: {
      source: MembershipSource;
      organizationId: string;
      orgMemberId: string;
      failedProjectId?: string;
      createdProjectIds: string[];
    },
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "DevEnvironmentProvisioningError";
  }
}

export function isAcceptInviteFormError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message === INVITE_NOT_FOUND ||
      error.message === ENV_SETUP_INCOMPLETE ||
      error.message === INVITE_BLOCKED_DIRECTORY_MANAGED)
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

  // Prisma can't express "order by name, falling back to email when unset"
  // case-insensitively in a single nested orderBy, so sort in JS here.
  const byDisplayName = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: "base" });

  const members = [...org.members].sort((a, b) =>
    byDisplayName(a.user.name ?? a.user.email, b.user.name ?? b.user.email)
  );
  const invites = [...org.invites].sort((a, b) => byDisplayName(a.email, b.email));

  return { members, invites };
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

  const uniqueEmails = new Set(emails);

  const existingMembers = await prisma.orgMember.findMany({
    where: {
      organizationId: org.id,
      user: { email: { in: boundedIn([...uniqueEmails]), mode: "insensitive" } },
    },
    select: { user: { select: { email: true } } },
  });
  // Compare folded: stored account emails and invite rows can both carry
  // casing the caller didn't type, and the unique org+email constraint the
  // P2002 below relies on is itself case-sensitive.
  const existingMemberEmails = new Set(
    existingMembers.map((member) => member.user.email.toLowerCase())
  );

  const pendingInvites = await prisma.orgMemberInvite.findMany({
    where: {
      organizationId: org.id,
      email: { in: boundedIn([...uniqueEmails]), mode: "insensitive" },
    },
    select: { email: true },
  });
  const pendingInviteEmails = new Set(pendingInvites.map((invite) => invite.email.toLowerCase()));

  // Create one invite per unique email and return ONLY the invites actually
  // created by this call. A P2002 means the email is already invited to this org
  // (unique org+email) — skip it so one duplicate can't fail the batch, and
  // don't return it: callers email exactly what they created, and re-sending an
  // already-pending invite is the dedicated resend flow's job (its own cooldown).
  // Looked up once, by the first event that needs it, after the invites are returned.
  let invitedRoleName: Promise<string | null> | undefined;
  const created: Prisma.OrgMemberInviteGetPayload<{
    include: { organization: true; inviter: true };
  }>[] = [];
  const alreadyMembers: string[] = [];
  const alreadyInvited: string[] = [];

  for (const email of uniqueEmails) {
    const folded = email.toLowerCase();

    if (existingMemberEmails.has(folded)) {
      alreadyMembers.push(email);
      continue;
    }

    if (pendingInviteEmails.has(folded)) {
      alreadyInvited.push(email);
      continue;
    }

    try {
      const invite = await prisma.orgMemberInvite.create({
        data: {
          // Store folded. The @@unique([organizationId, email]) backstop is
          // case-sensitive, so it only catches a concurrent duplicate if every
          // row for an address is written the same way — this keeps that true
          // regardless of what a caller passes in.
          email: folded,
          token: tokenGenerator(),
          organizationId: org.id,
          inviterId: userId,
          role: "MEMBER",
          rbacRoleId: rbacRoleId ?? null,
        },
        include: {
          organization: true,
          inviter: true,
        },
      });
      created.push(invite);
      const invitedRoleId = invite.rbacRoleId;
      if (invitedRoleId) {
        recordMemberAuditEventInBackground(
          async () => ({
            category: "members",
            action: "member.invited",
            organizationId: org.id,
            target: inviteAuditTarget(invite),
            changes: {
              role: await (invitedRoleName ??= auditRoleName(org.id, invitedRoleId)),
            },
          }),
          { action: "member.invited", organizationId: org.id }
        );
      } else {
        auditLogs.record({
          category: "members",
          action: "member.invited",
          organizationId: org.id,
          target: inviteAuditTarget(invite),
          changes: null,
        });
      }
    } catch (error) {
      if (
        error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        alreadyInvited.push(email);
        continue;
      }
      throw error;
    }
  }

  return { created, alreadyMembers, alreadyInvited };
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

// Invites match the address they were sent to, ignoring case. Don't use
// Prisma's `equals` with `mode: "insensitive"` for this: it compiles to ILIKE,
// so "_" and "%" in an address act as wildcards and `j_smith@` would match an
// invite for `j.smith@`.
function inviteEmailMatches(inviteEmail: string, userEmail: string) {
  return inviteEmail.toLowerCase() === userEmail.toLowerCase();
}

async function findInviteIdsForEmail(client: PrismaClientOrTransaction, email: string) {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "OrgMemberInvite" WHERE lower("email") = ${email.toLowerCase()}
  `;
  return rows.map((row) => row.id);
}

export async function getUsersInvites({ email }: { email: string }) {
  const inviteIds = await findInviteIdsForEmail(prisma, email);

  return await prisma.orgMemberInvite.findMany({
    where: {
      id: { in: boundedIn(inviteIds) },
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

export async function getProjectsMissingMemberDevelopmentEnvironments({
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
      organizationId,
      ...memberDevelopmentEnvironmentWhere({
        orgMemberId: memberId,
        projectId: { in: boundedIn(projects.map((project) => project.id)) },
      }),
    },
    select: { projectId: true },
  });
  const existingProjectIds = new Set(existingEnvs.map((env) => env.projectId));

  return projects.filter((project) => !existingProjectIds.has(project.id));
}

export async function provisionMemberDevelopmentEnvironments({
  source,
  inviteId,
  member,
  organization,
  projects,
  maximumConcurrencyLimit,
}: {
  source: MembershipSource;
  inviteId?: string;
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
  const requestedProjectIds = projects.map((project) => project.id);
  const createdProjectIds: string[] = [];
  let failedProjectId: string | undefined;
  let failedProjectIndex: number | undefined;

  try {
    for (const [index, project] of projectsNeedingEnvs.entries()) {
      failedProjectId = project.id;
      failedProjectIndex = index;

      const { created } = await createDevelopmentEnvironmentForMember({
        organization,
        project,
        member,
        maximumConcurrencyLimit,
        createdBy: userActor(member.userId),
      });

      if (created) {
        createdProjectIds.push(project.id);
      }
      failedProjectId = undefined;
      failedProjectIndex = undefined;
    }
  } catch (error) {
    const message =
      "provisionMemberDevelopmentEnvironments: development environment creation failed after membership created";
    const context = {
      source,
      inviteId,
      userId: member.userId,
      organizationId: organization.id,
      orgMemberId: member.id,
      requestedProjectIds,
      failedProjectId,
      failedProjectIndex,
      projectsNeedingEnvs: projectsNeedingEnvs.length,
      createdProjectIds,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    };

    if (source === "invite") {
      logger.error(message, context);
    } else {
      logger.warn(message, context);
    }

    throw new DevEnvironmentProvisioningError(
      `Failed to create development environments for org member ${member.id}`,
      {
        source,
        organizationId: organization.id,
        orgMemberId: member.id,
        failedProjectId,
        createdProjectIds,
      },
      { cause: error }
    );
  }
}

/** Provisions inline and surfaces a failure to the joiner as a retryable message. */
async function provisionInviteDevelopmentEnvironments(args: {
  inviteId: string;
  member: OrgMember;
  organization: Pick<Organization, "id" | "maximumConcurrencyLimit">;
  projects: Pick<Project, "id">[];
  maximumConcurrencyLimit: number;
}) {
  try {
    await provisionMemberDevelopmentEnvironments({ source: "invite", ...args });
  } catch (error) {
    if (error instanceof DevEnvironmentProvisioningError) {
      throw new Error(ENV_SETUP_INCOMPLETE, { cause: error });
    }
    throw error;
  }
}

/**
 * Whether this call assigned the invite's role. The role is recorded by the request that assigned
 * it: in `invite.accepted` when that request consumed the invite, otherwise here as
 * `member.role_changed` (`recordRoleChange`). Concurrent accepts of one invite can consume it in one
 * request and assign the role in another, in either order.
 */
async function assignInviteRbacRole({
  userId,
  organizationId,
  rbacRoleId,
  onlyWhenUnassigned,
  recordRoleChange,
}: {
  userId: string;
  organizationId: string;
  rbacRoleId: string;
  onlyWhenUnassigned: boolean;
  /** The member the role change event names, when this request didn't consume the invite. */
  recordRoleChange?: { memberId: string; email: string };
}): Promise<boolean> {
  try {
    let roleBefore: { id: string; name: string } | null = null;
    if (onlyWhenUnassigned) {
      const currentRole = await rbac.getUserRole({ userId, organizationId });
      if (currentRole !== null) {
        return false;
      }
    } else if (recordRoleChange && auditLogs.isRecordingEnabled()) {
      // Best-effort, like setOrgMemberRole: a failed read records an unknown "before".
      const [roleBeforeError, currentRole] = await tryCatch(
        rbac.getUserRole({ userId, organizationId })
      );
      if (roleBeforeError) {
        logger.warn("acceptInvite: failed to read the role before assigning the invite's role", {
          organizationId,
          userId,
          error: roleBeforeError,
        });
      }
      roleBefore = currentRole ?? null;
    }

    const roleResult = await rbac.setUserRole({
      userId,
      organizationId,
      roleId: rbacRoleId,
    });
    if (roleResult.ok && recordRoleChange && roleBefore?.id !== rbacRoleId) {
      recordMemberAuditEventInBackground(
        async () => ({
          category: "members",
          action: "member.role_changed",
          organizationId,
          target: memberAuditTarget({
            id: recordRoleChange.memberId,
            user: { email: recordRoleChange.email },
          }),
          changes: {
            role: {
              before: roleBefore?.name ?? null,
              after: await auditRoleName(organizationId, rbacRoleId),
            },
          },
        }),
        { action: "member.role_changed", organizationId }
      );
    }
    if (!roleResult.ok) {
      if (roleResult.code === "last_owner") {
        logger.info("acceptInvite: kept last Owner, skipped RBAC role assignment", {
          organizationId,
          userId,
          rbacRoleId,
        });
      } else {
        logger.warn("acceptInvite: skipped RBAC role assignment", {
          organizationId,
          userId,
          rbacRoleId,
          reason: roleResult.error,
        });
      }
    }
    return roleResult.ok;
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
    return false;
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

  await provisionInviteDevelopmentEnvironments({
    inviteId,
    member,
    organization: member.organization,
    projects: missingProjects,
    maximumConcurrencyLimit,
  });
  await enqueueAttioMemberSync({ organizationId, userId: user.id });

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
  const found = await prisma.orgMemberInvite.findFirst({
    where: {
      id: inviteId,
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
  const invite = found && inviteEmailMatches(found.email, user.email) ? found : null;

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

  // Directory-managed membership: accepting an invite would add a member
  // outside the directory. Block it (the invite can still be revoked by an
  // admin). Fail-open on a plugin error so a hiccup doesn't strand joiners.
  const membershipPolicy = await ssoController.getMembershipPolicy(invite.organizationId);
  if (membershipPolicy.isOk() && !membershipPolicy.value.manualMembershipAllowed) {
    throw new Error(INVITE_BLOCKED_DIRECTORY_MANAGED);
  }
  if (!(await isOrganizationJoinAllowed({ organizationId: invite.organizationId }))) {
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

  let membershipCreated = false;

  if (!member) {
    try {
      member = await prisma.orgMember.create({
        data: {
          organizationId: invite.organizationId,
          userId: user.id,
          role: invite.role,
          invitedById: invite.inviterId,
          joinMethod: "invite" satisfies OrgMemberJoinMethod,
        },
      });
      membershipCreated = true;
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

  await provisionInviteDevelopmentEnvironments({
    inviteId,
    member,
    organization: invite.organization,
    projects: invite.organization.projects,
    maximumConcurrencyLimit,
  });

  // Consume the invite only after development environments are provisioned so
  // a failed setup can be retried from /invites.
  let inviteConsumed = false;
  try {
    await prisma.orgMemberInvite.delete({
      where: {
        id: inviteId,
        email: invite.email,
      },
    });
    inviteConsumed = true;
  } catch (error) {
    if (
      !(error instanceof PrismaNamespace.PrismaClientKnownRequestError && error.code === "P2025")
    ) {
      throw error;
    }
  }

  const assignedRoleId =
    invite.rbacRoleId &&
    (await assignInviteRbacRole({
      userId: user.id,
      organizationId: invite.organization.id,
      rbacRoleId: invite.rbacRoleId,
      onlyWhenUnassigned: !membershipCreated,
      recordRoleChange: inviteConsumed ? undefined : { memberId: member.id, email: user.email },
    }))
      ? invite.rbacRoleId
      : null;

  // Only the request that consumed the invite records it, with the invite's role when this request
  // assigned it. A concurrent accept that assigns it instead records member.role_changed.
  if (inviteConsumed) {
    const accepted = {
      category: "members",
      action: "invite.accepted",
      organizationId: invite.organizationId,
      target: inviteAuditTarget(invite),
    } as const;
    if (assignedRoleId) {
      recordMemberAuditEventInBackground(
        async () => ({
          ...accepted,
          changes: { role: await auditRoleName(invite.organizationId, assignedRoleId) },
        }),
        { action: "invite.accepted", organizationId: invite.organizationId }
      );
    } else {
      auditLogs.record(accepted);
    }
  }

  // After the role is applied, also when an earlier attempt already created the membership.
  await enqueueAttioMemberSync({ organizationId: invite.organizationId, userId: user.id });

  const remainingInvites = await getUsersInvites({ email: user.email });

  // Deliberate re-admission clears any sticky-removal tombstone so this
  // membership isn't shadowed by a prior removal (best-effort; no-op in OSS).
  await ssoController
    .clearMembershipRemoval({ organizationId: invite.organization.id, userId: user.id })
    .unwrapOr(undefined);

  return { remainingInvites, organization: invite.organization };
}

export async function declineInvite({
  user,
  inviteId,
}: {
  user: { id: string; email: string };
  inviteId: string;
}) {
  return await prisma.$transaction(async (tx) => {
    //1. delete invite
    const invite = await tx.orgMemberInvite.findFirst({ where: { id: inviteId } });
    if (!invite || !inviteEmailMatches(invite.email, user.email)) {
      throw new Error(INVITE_NOT_FOUND);
    }

    const declinedInvite = await tx.orgMemberInvite.delete({
      where: {
        id: inviteId,
        email: invite.email,
      },
      include: {
        organization: true,
      },
    });

    //2. check for other invites
    const remainingInvites = await tx.orgMemberInvite.findMany({
      where: {
        id: { in: boundedIn(await findInviteIdsForEmail(tx, user.email)) },
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

  auditLogs.record({
    category: "members",
    action: "invite.revoked",
    organizationId: invite.organization.id,
    target: inviteAuditTarget(invite),
  });

  return { email: invite.email, organization: invite.organization };
}
