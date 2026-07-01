import type { PrismaClient, RuntimeEnvironmentType } from "@trigger.dev/database";
import type { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";

let idCounter = 0;

export function uniqueId(prefix: string) {
  idCounter += 1;
  return `${prefix}-${idCounter}-${Date.now()}`;
}

export async function createTestUser(prisma: PrismaClient, email?: string) {
  return prisma.user.create({
    data: {
      email: email ?? `${uniqueId("user")}@test.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
}

export async function createTestOrgProjectWithMember(
  prisma: PrismaClient,
  options?: { userId?: string }
) {
  const user = options?.userId
    ? await prisma.user.findUniqueOrThrow({ where: { id: options.userId } })
    : await createTestUser(prisma);

  const orgSlug = uniqueId("org");
  const organization = await prisma.organization.create({
    data: {
      title: "Test Org",
      slug: orgSlug,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
    include: { members: true },
  });

  const projectSlug = uniqueId("proj");
  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: projectSlug,
      organizationId: organization.id,
      externalRef: uniqueId("ext"),
    },
  });

  return {
    user,
    organization,
    project,
    orgMember: organization.members[0]!,
    projectSlug,
  };
}

export async function createRuntimeEnvironment(
  prisma: PrismaClient,
  options: {
    projectId: string;
    organizationId: string;
    type: RuntimeEnvironmentType;
    orgMemberId?: string | null;
    slug?: string;
  }
) {
  const slug = options.slug ?? uniqueId("env");
  return prisma.runtimeEnvironment.create({
    data: {
      slug,
      type: options.type,
      projectId: options.projectId,
      organizationId: options.organizationId,
      orgMemberId: options.orgMemberId ?? null,
      apiKey: uniqueId("api"),
      pkApiKey: uniqueId("pk"),
      shortcode: uniqueId("sc"),
    },
  });
}

export async function createEnvironmentVariable(
  repository: EnvironmentVariablesRepository,
  projectId: string,
  options: {
    environmentId: string;
    key: string;
    value: string;
    isSecret?: boolean;
    userId: string;
  }
) {
  const result = await repository.create(projectId, {
    override: true,
    environmentIds: [options.environmentId],
    variables: [{ key: options.key, value: options.value }],
    isSecret: options.isSecret ?? false,
    lastUpdatedBy: { type: "user", userId: options.userId },
  });

  if (!result.success) {
    throw new Error(result.error);
  }
}
