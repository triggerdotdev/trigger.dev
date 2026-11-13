import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { VercelSettingsPresenter } from "~/presenters/v3/VercelSettingsPresenter.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { environmentSecretPrefix } from "~/services/environmentEncryption/secretStore.server";
import { encryptValue } from "~/utils/encryptionKeyring.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

// Catches: unreadable secrets blocking Vercel settings, or archived/foreign environments appearing in its metadata.
postgresTest(
  "Vercel settings lists existing variables without decrypting values",
  async ({ prisma }) => {
    const { project, organization } = await createTestOrgProjectWithMember(prisma);
    const environments = await Promise.all(
      ["prod", "staging", "archived"].map((slug) =>
        createRuntimeEnvironment(prisma, {
          projectId: project.id,
          organizationId: organization.id,
          type: "PRODUCTION",
          slug,
        })
      )
    );
    await prisma.runtimeEnvironment.update({
      where: { id: environments[2]!.id },
      data: { archivedAt: new Date() },
    });
    const other = await createTestOrgProjectWithMember(prisma);
    const foreign = await createRuntimeEnvironment(prisma, {
      projectId: other.project.id,
      organizationId: other.organization.id,
      type: "PRODUCTION",
      slug: "foreign",
    });
    const unreadable = encryptValue(JSON.stringify({ secret: "unavailable" }), {
      activeKeyId: "unconfigured-vercel-test-key",
      keys: new Map([["unconfigured-vercel-test-key", "k".repeat(32)]]),
    });
    for (const variable of [
      { projectId: project.id, key: "SHARED", environments },
      { projectId: project.id, key: "ARCHIVED_ONLY", environments: [environments[2]!] },
      { projectId: other.project.id, key: "FOREIGN", environments: [foreign] },
    ]) {
      const keys = variable.environments.map(
        (environment) =>
          `${environmentSecretPrefix(variable.projectId, environment.id)}${variable.key}`
      );
      await prisma.environmentVariable.create({
        data: {
          projectId: variable.projectId,
          key: variable.key,
          friendlyId: uniqueId("envvar"),
          values: {
            create: variable.environments.map((environment, i) => ({
              environment: { connect: { id: environment.id } },
              valueReference: { create: { key: keys[i]! } },
            })),
          },
        },
      });
      await prisma.secretStore.createMany({
        data: keys.map((key) => ({ key, version: "2", value: unreadable })),
      });
    }

    await expect(
      new EnvironmentVariablesRepository(prisma, prisma).getProject(project.id)
    ).rejects.toThrow();
    const existing = await new VercelSettingsPresenter(prisma, prisma).getExistingVariables(
      project.id
    );
    expect(Object.keys(existing)).toEqual(["SHARED"]);
    expect(existing.SHARED!.environments.toSorted()).toEqual(["prod", "staging"]);
  }
);
