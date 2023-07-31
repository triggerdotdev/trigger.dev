import type { Prisma, User } from "@trigger.dev/database";
import type { GitHubProfile } from "remix-auth-github";
import { prisma } from "~/db.server";
export type { User } from "@trigger.dev/database";

type FindOrCreateMagicLink = {
  authenticationMethod: "MAGIC_LINK";
  email: string;
};

type FindOrCreateGithub = {
  authenticationMethod: "GITHUB";
  email: User["email"];
  authenticationProfile: GitHubProfile;
  authenticationExtraParams: Record<string, unknown>;
};

type FindOrCreateUser = FindOrCreateMagicLink | FindOrCreateGithub;

type LoggedInUser = {
  user: User;
  isNewUser: boolean;
};

export async function findOrCreateUser(
  input: FindOrCreateUser
): Promise<LoggedInUser> {
  switch (input.authenticationMethod) {
    case "GITHUB": {
      return findOrCreateGithubUser(input);
    }
    case "MAGIC_LINK": {
      return findOrCreateMagicLinkUser(input);
    }
  }
}

export async function findOrCreateMagicLinkUser(
  input: FindOrCreateMagicLink
): Promise<LoggedInUser> {
  const existingUser = await prisma.user.findFirst({
    where: {
      email: input.email,
    },
  });

  const user = await prisma.user.upsert({
    where: {
      email: input.email,
    },
    update: { email: input.email },
    create: { email: input.email, authenticationMethod: "MAGIC_LINK" },
  });

  return {
    user,
    isNewUser: !existingUser,
  };
}

export async function findOrCreateGithubUser({
  email,
  authenticationProfile,
  authenticationExtraParams,
}: FindOrCreateGithub): Promise<LoggedInUser> {
  const name = authenticationProfile._json.name;
  let avatarUrl: string | undefined = undefined;
  if (authenticationProfile.photos[0]) {
    avatarUrl = authenticationProfile.photos[0].value;
  }
  const displayName = authenticationProfile.displayName;
  const authProfile = authenticationProfile
    ? (authenticationProfile as unknown as Prisma.JsonObject)
    : undefined;
  const authExtraParams = authenticationExtraParams
    ? (authenticationExtraParams as unknown as Prisma.JsonObject)
    : undefined;

  const authIdentifier = `github:${authenticationProfile.id}`;

  const existingUser = await prisma.user.findUnique({
    where: {
      authIdentifier,
    },
  });

  const existingEmailUser = await prisma.user.findUnique({
    where: {
      email,
    },
  });

  if (existingEmailUser && !existingUser) {
    const user = await prisma.user.update({
      where: {
        email,
      },
      data: {
        authenticationProfile: authProfile,
        authenticationExtraParams: authExtraParams,
        avatarUrl,
        authIdentifier,
      },
    });

    return {
      user,
      isNewUser: false,
    };
  }

  if (existingEmailUser && existingUser) {
    const user = await prisma.user.update({
      where: {
        id: existingUser.id,
      },
      data: {},
    });

    return {
      user,
      isNewUser: false,
    };
  }

  const user = await prisma.user.upsert({
    where: {
      authIdentifier,
    },
    update: {},
    create: {
      authenticationProfile: authProfile,
      authenticationExtraParams: authExtraParams,
      name,
      avatarUrl,
      displayName,
      authIdentifier,
      email,
      authenticationMethod: "GITHUB",
    },
  });

  return {
    user,
    isNewUser: !existingUser,
  };
}

export async function getUserById(id: User["id"]) {
  return prisma.user.findUnique({ where: { id } });
}

export async function getUserByEmail(email: User["email"]) {
  return prisma.user.findUnique({ where: { email } });
}

export function updateUser({
  id,
  name,
  email,
  marketingEmails,
}: Pick<User, "id" | "name" | "email"> & {
  marketingEmails?: boolean;
}) {
  return prisma.user.update({
    where: { id },
    data: { name, email, marketingEmails, confirmedBasicDetails: true },
  });
}

export async function grantUserCloudAccess({
  id,
  inviteCode,
}: {
  id: string;
  inviteCode: string;
}) {
  return prisma.user.update({
    where: { id },
    data: {
      invitationCode: {
        connect: {
          code: inviteCode,
        },
      },
    },
  });
}
