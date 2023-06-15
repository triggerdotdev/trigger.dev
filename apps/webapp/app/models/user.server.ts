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
  accessToken: User["accessToken"];
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
  accessToken,
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

  const fields = {
    accessToken,
    authenticationProfile: authProfile,
    authenticationExtraParams: authExtraParams,
    name,
    avatarUrl,
    displayName,
  };

  const existingUser = await prisma.user.findFirst({
    where: {
      email,
    },
  });

  const user = await prisma.user.upsert({
    where: {
      email,
    },
    update: fields,
    create: { ...fields, email, authenticationMethod: "GITHUB" },
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
