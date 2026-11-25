import type {
  Organization,
  OrgMember,
  PrismaClientOrTransaction,
  Project,
} from "@trigger.dev/database";
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
import { deleteMembership } from "./orgMember.server";
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
const INVITE_ROLE_UNAVAILABLE =
  "This invite's role isn't available in the organization anymore. Ask for a new invite.";
const INVITE_JOIN_FAILED =
  "We couldn't finish adding you to the organization. Please try accepting the invite again.";
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
      error.message === INVITE_ROLE_UNAVAILABLE ||
      error.message === INVITE_JOIN_FAILED ||
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
 * Writes the invite's role unless the member already has one assigned, and returns whether this call
 * wrote it. If it can't be written, undoes a membership this request created and throws the message
 * the invitee sees.
 */
async function writeInviteRole({
  organizationId,
  rbacRoleId,
  userId,
  memberId,
  membershipCreated,
}: {
  organizationId: string;
  rbacRoleId: string;
  userId: string;
  memberId: string;
  membershipCreated: boolean;
}): Promise<boolean> {
  const result = await rbac
    .setUserRole({ userId, organizationId, roleId: rbacRoleId, onlyIfUnassigned: true })
    .catch((error) => ({ ok: false as const, error: String(error), code: undefined }));
  if (result.ok) {
    return !result.kept;
  }

  logger.warn("acceptInvite: couldn't assign the invite's role", {
    organizationId,
    userId,
    rbacRoleId,
    reason: result.error,
  });
  // Undone the way a removal does it (member lock, development keys rotated). A membership already
  // removed needs no undo.
  if (membershipCreated && result.code !== "not_a_member") {
    await deleteMembership(memberId, organizationId).catch((error) =>
      logger.error("acceptInvite: couldn't undo a membership whose role failed", {
        organizationId,
        userId,
        error: String(error),
      })
    );
  }
  // "Ask for a new invite" only when the role really is gone; anything else is worth a retry.
  const available = await isInviteRoleAvailable(organizationId, rbacRoleId).catch(() => true);
  throw new Error(available ? INVITE_JOIN_FAILED : INVITE_ROLE_UNAVAILABLE);
}

/**
 * Whether the invite's role can still be assigned, by the rules setUserRole applies: a built-in role
 * the org's plan offers, or a custom role that still exists in the org. Always true without the
 * plugin.
 */
async function isInviteRoleAvailable(organizationId: string, roleId: string): Promise<boolean> {
  const systemRoles = await rbac.systemRoles(organizationId);
  // Without the plugin no role is enforced, so none is unavailable.
  if (!systemRoles) {
    return true;
  }
  const builtIn = systemRoles.find((role) => role.id === roleId);
  if (builtIn) {
    return builtIn.available;
  }
  return (await rbac.allRoles(organizationId)).some((role) => role.id === roleId);
}

/**
 * Records an invite's role as member.role_changed, for a request that wrote it but didn't consume
 * the invite. No "before": the member just joined, and the legacy fallback they resolved to until
 * the write was never theirs.
 */
function recordInviteRoleChange({
  organizationId,
  member,
  rbacRoleId,
}: {
  organizationId: string;
  member: { id: string; email: string };
  rbacRoleId: string;
}) {
  recordMemberAuditEventInBackground(
    async () => ({
      category: "members",
      action: "member.role_changed",
      organizationId,
      target: memberAuditTarget({ id: member.id, user: { email: member.email } }),
      changes: {
        role: {
          before: null,
          after: await auditRoleName(organizationId, rbacRoleId),
        },
      },
    }),
    { action: "member.role_changed", organizationId }
  );
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
  const usingRbacPlugin = await rbac.isUsingPlugin();

  if (!member) {
    // An explicit role outranks the invite's, so a role left over from an earlier membership would
    // come back on rejoin (e.g. a former Owner re-invited without a role). Clear it before joining,
    // and refuse the accept if that fails.
    const cleared = await rbac.removeFormerMemberRoles({
      userId: user.id,
      organizationId: invite.organizationId,
    });
    if (!cleared.ok) {
      logger.warn("acceptInvite: couldn't clear a former member's roles before joining", {
        organizationId: invite.organizationId,
        userId: user.id,
        reason: cleared.error,
      });
      throw new Error(INVITE_JOIN_FAILED);
    }
    // Refuse before joining when the invite's role is no longer available (say after a plan
    // change), so no membership exists that a concurrent accept could consume the invite for.
    if (
      invite.rbacRoleId &&
      !(await isInviteRoleAvailable(invite.organizationId, invite.rbacRoleId))
    ) {
      throw new Error(INVITE_ROLE_UNAVAILABLE);
    }

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

  // Until the invite's role is written, the member resolves to the legacy fallback (Admin), so write
  // it before environment setup, and never consume the invite without it. That's the request that
  // created the membership, or one retrying an accept of this invite: a member who joined by invite
  // while this invite still exists joined through it (an invite can't be sent to a member). A member
  // who joined another way (e.g. SSO) keeps their role. Written only if no role is assigned yet, so
  // a role an Owner set in the meantime stays, and only one request writes it.
  const retryOfThisInvite =
    !membershipCreated && member.joinMethod === ("invite" satisfies OrgMemberJoinMethod);
  // The invite's role when this request wrote it, so this request records it.
  const assignedRoleId =
    usingRbacPlugin &&
    invite.rbacRoleId &&
    (membershipCreated || retryOfThisInvite) &&
    (await writeInviteRole({
      organizationId: invite.organizationId,
      rbacRoleId: invite.rbacRoleId,
      userId: user.id,
      memberId: member.id,
      membershipCreated,
    }))
      ? invite.rbacRoleId
      : null;

  try {
    await provisionInviteDevelopmentEnvironments({
      inviteId,
      member,
      organization: invite.organization,
      projects: invite.organization.projects,
      maximumConcurrencyLimit,
    });
  } catch (error) {
    // The role written above stays, but this request won't reach the audit events below, and a
    // retry finds it already in place. Record it now, as a role change.
    if (assignedRoleId) {
      recordInviteRoleChange({
        organizationId: invite.organizationId,
        member: { id: member.id, email: user.email },
        rbacRoleId: assignedRoleId,
      });
    }
    throw error;
  }

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

  // The request that wrote the role records it: with invite.accepted when it consumed the invite,
  // otherwise as a role change.
  if (assignedRoleId && !inviteConsumed) {
    recordInviteRoleChange({
      organizationId: invite.organizationId,
      member: { id: member.id, email: user.email },
      rbacRoleId: assignedRoleId,
    });
  }

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
