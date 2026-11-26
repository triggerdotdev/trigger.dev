import { postgresTest } from "@internal/testcontainers";
import { expect, onTestFinished, vi } from "vitest";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

postgresTest(
  "dev branch attempts inherit parent variables and prefer branch overrides",
  async ({ prisma, postgresContainer }) => {
    const url = postgresContainer.getConnectionUri();
    vi.stubEnv("DATABASE_URL", url);
    vi.stubEnv("DIRECT_URL", url);
    vi.stubEnv("DATABASE_READ_REPLICA_URL", undefined);
    onTestFinished(() => vi.unstubAllEnvs());

    const { resolveAttemptVariables } =
      await import("~/services/environmentEncryption/attemptVariables.server");
    const { EnvironmentVariablesRepository } =
      await import("~/v3/environmentVariables/environmentVariablesRepository.server");
    const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
    const environment = {
      projectId: project.id,
      organizationId: organization.id,
      type: "DEVELOPMENT" as const,
      orgMemberId: orgMember.id,
    };
    const parent = await createRuntimeEnvironment(prisma, environment);
    const branch = await prisma.runtimeEnvironment.update({
      where: { id: (await createRuntimeEnvironment(prisma, environment)).id },
      data: { parentEnvironmentId: parent.id, branchName: "feature" },
    });
    const repository = new EnvironmentVariablesRepository(prisma, prisma);
    await expect(
      repository.create(project.id, {
        override: false,
        environmentIds: [parent.id],
        variables: [
          { key: "INHERITED", value: "parent" },
          { key: "OVERRIDDEN", value: "parent" },
        ],
      })
    ).resolves.toEqual({ success: true });
    await expect(
      repository.create(project.id, {
        override: false,
        environmentIds: [branch.id],
        variables: [{ key: "OVERRIDDEN", value: "branch" }],
      })
    ).resolves.toEqual({ success: true });

    const { variables } = await resolveAttemptVariables(branch);
    expect(Object.fromEntries(variables.map(({ key, value }) => [key, value]))).toMatchObject({
      INHERITED: "parent",
      OVERRIDDEN: "branch",
    });
  }
);
