import { describe, expect, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  $transaction: async (
    prismaClient: {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    },
    nameOrFn: string | ((tx: unknown) => Promise<unknown>),
    fnOrOptions?: ((tx: unknown) => Promise<unknown>) | unknown
  ) => {
    const fn =
      typeof nameOrFn === "string"
        ? (fnOrOptions as (tx: unknown) => Promise<unknown>)
        : nameOrFn;

    return prismaClient.$transaction(fn);
  },
}));

import { postgresTest } from "@internal/testcontainers";
import { EnvironmentVariablesPresenter } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  createEnvironmentVariable,
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

describe("EnvironmentVariablesPresenter", () => {
  postgresTest("keeps secret values redacted while returning non-secret values", async ({ prisma }) => {
    const { user, organization, project, projectSlug } = await createTestOrgProjectWithMember(prisma);
    const production = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const repository = new EnvironmentVariablesRepository(prisma, prisma);

    await createEnvironmentVariable(repository, project.id, {
      environmentId: production.id,
      key: "SECRET_VAR",
      value: "super-secret",
      isSecret: true,
      userId: user.id,
    });
    await createEnvironmentVariable(repository, project.id, {
      environmentId: production.id,
      key: "PLAIN_VAR",
      value: "plain-value",
      isSecret: false,
      userId: user.id,
    });

    const result = await new EnvironmentVariablesPresenter(prisma).call({
      userId: user.id,
      projectSlug,
    });

    const secretVariable = result.environmentVariables.find((variable) => variable.key === "SECRET_VAR");
    const nonSecretVariable = result.environmentVariables.find((variable) => variable.key === "PLAIN_VAR");

    expect(secretVariable).toBeDefined();
    expect(nonSecretVariable).toBeDefined();
    expect(secretVariable!.value).toBe("");
    expect(nonSecretVariable!.value).toBe("plain-value");
  });
});
