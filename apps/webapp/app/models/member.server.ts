import { prisma } from "~/db.server";
import { createEnvironment } from "./organization.server";

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

  return prisma.orgMember.delete({
    where: {
      id: memberId,
    },
    include: {
      organization: true,
      user: true,
    },
  });
}

export async function inviteMembers({
  slug,
  emails,
  userId,
}: {
  slug: string;
  emails: string[];
  userId: string;
}) {
  const org = await prisma.organization.findFirst({
    where: { slug, members: { some: { userId } } },
  });

  if (!org) {
    throw new Error("User does not have access to this organization");
  }

  const created = await prisma.orgMemberInvite.createMany({
    data: emails.map((email) => ({
      email,
      organizationId: org.id,
      inviterId: userId,
      role: "MEMBER",
    })),
    skipDuplicates: true,
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

export async function getInviteFromToken({ token, userId }: { token: string; userId: string }) {
  return await prisma.orgMemberInvite.findFirst({
    where: {
      token,
      organization: {
        members: {
          some: {
            userId,
          },
        },
      },
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

export async function acceptInvite({ userId, inviteId }: { userId: string; inviteId: string }) {
  return await prisma.$transaction(async (tx) => {
    // 1. Delete the invite and get the invite details
    const invite = await tx.orgMemberInvite.delete({
      where: {
        id: inviteId,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
      include: {
        organization: {
          include: {
            projects: true,
          },
        },
      },
    });

    // 2. Join the organization
    const member = await tx.orgMember.create({
      data: {
        organizationId: invite.organizationId,
        userId,
        role: invite.role,
      },
    });

    // 3. Create an environment for each project
    for (const project of invite.organization.projects) {
      await createEnvironment({
        organization: invite.organization,
        project,
        type: "DEVELOPMENT",
        isBranchableEnvironment: false,
        member,
        prismaClient: tx,
      });
    }

    // 4. Check for other invites
    const remainingInvites = await tx.orgMemberInvite.findMany({
      where: {
        email: invite.email,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    return { remainingInvites, organization: invite.organization };
  });
}

export async function declineInvite({ userId, inviteId }: { userId: string; inviteId: string }) {
  return await prisma.$transaction(async (tx) => {
    //1. delete invite
    const declinedInvite = await prisma.orgMemberInvite.delete({
      where: {
        id: inviteId,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
      include: {
        organization: true,
      },
    });

    //2. get email
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    //3. check for other invites
    const remainingInvites = await prisma.orgMemberInvite.findMany({
      where: {
        email: user!.email,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
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
  const invite = await prisma.orgMemberInvite.delete({
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
      email: true,
      organization: true,
    },
  });

  if (!invite) {
    throw new Error("Invite not found");
  }

  return { email: invite.email, organization: invite.organization };
}
