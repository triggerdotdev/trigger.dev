import type { Prisma, User } from "@trigger.dev/database";
import type { GitHubProfile } from "remix-auth-github";
import type { GoogleProfile } from "remix-auth-google";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  DashboardPreferences,
  getDashboardPreferences,
} from "~/services/dashboardPreferences.server";
export type { User } from "@trigger.dev/database";
import { assertEmailAllowed } from "~/utils/email";
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

type FindOrCreateGoogle = {
  authenticationMethod: "GOOGLE";
  email: User["email"];
  authenticationProfile: GoogleProfile;
  authenticationExtraParams: Record<string, unknown>;
};

type FindOrCreateUser = FindOrCreateMagicLink | FindOrCreateGithub | FindOrCreateGoogle;

type LoggedInUser = {
  user: User;
  isNewUser: boolean;
};

export async function findOrCreateUser(input: FindOrCreateUser): Promise<LoggedInUser> {
  switch (input.authenticationMethod) {
    case "GITHUB": {
      return findOrCreateGithubUser(input);
    }
    case "MAGIC_LINK": {
      return findOrCreateMagicLinkUser(input);
    }
    case "GOOGLE": {
      return findOrCreateGoogleUser(input);
    }
  }
}

export async function findOrCreateMagicLinkUser({
  email,
}: FindOrCreateMagicLink): Promise<LoggedInUser> {
  assertEmailAllowed(email);

  const existingUser = await prisma.user.findFirst({
    where: {
      email,
    },
  });

  const adminEmailRegex = env.ADMIN_EMAILS ? new RegExp(env.ADMIN_EMAILS) : undefined;
  const makeAdmin = adminEmailRegex ? adminEmailRegex.test(email) : false;

  const user = await prisma.user.upsert({
    where: {
      email,
    },
    update: {
      email,
    },
    create: {
      email,
      authenticationMethod: "MAGIC_LINK",
      admin: makeAdmin, // only on create, to prevent automatically removing existing admins
    },
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
  assertEmailAllowed(email);

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

export async function findOrCreateGoogleUser({
  email,
  authenticationProfile,
  authenticationExtraParams,
}: FindOrCreateGoogle): Promise<LoggedInUser> {
  assertEmailAllowed(email);

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

  const authIdentifier = `google:${authenticationProfile.id}`;

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
    // Link existing email account to Google auth
    const user = await prisma.user.update({
      where: {
        email,
      },
      data: {
        authenticationMethod: "GOOGLE",
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
    // User already linked to Google, update profile info
    const user = await prisma.user.update({
      where: {
        id: existingUser.id,
      },
      data: {
        avatarUrl,
        authenticationProfile: authProfile,
        authenticationExtraParams: authExtraParams,
      },
    });

    return {
      user,
      isNewUser: false,
    };
  }

  // When the IDP user (Google) already exists, the "update" path will be taken and the email will be updated
  // It's not possible that the email is already taken by a different user because that would have been handled
  // by one of the if statements above.
  const user = await prisma.user.upsert({
    where: {
      authIdentifier,
    },
    update: {
      email,
      displayName,
      name,
      avatarUrl,
    },
    create: {
      authenticationProfile: authProfile,
      authenticationExtraParams: authExtraParams,
      name,
      avatarUrl,
      displayName,
      authIdentifier,
      email,
      authenticationMethod: "GOOGLE",
    },
  });

  return {
    user,
    isNewUser: !existingUser,
  };
}

export type UserWithDashboardPreferences = User & {
  dashboardPreferences: DashboardPreferences;
};

export async function getUserById(id: User["id"]) {
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    return null;
  }

  const dashboardPreferences = getDashboardPreferences(user.dashboardPreferences);

  return {
    ...user,
    dashboardPreferences,
  };
}

export async function getUserByEmail(email: User["email"]) {
  return prisma.user.findUnique({ where: { email } });
}

export function updateUser({
  id,
  name,
  email,
  marketingEmails,
  referralSource,
}: Pick<User, "id" | "name" | "email"> & {
  marketingEmails?: boolean;
  referralSource?: string;
}) {
  return prisma.user.update({
    where: { id },
    data: { name, email, marketingEmails, referralSource, confirmedBasicDetails: true },
  });
}

export async function grantUserCloudAccess({ id, inviteCode }: { id: string; inviteCode: string }) {
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
