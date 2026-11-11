import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import {
  deleteTrustedDeployRepository,
  deleteTrustedDeployEnvironment,
  saveTrustedDeployEnvironment,
  saveTrustedDeployRepository,
  TrustedDeploySettingsError,
} from "~/services/trustedDeploys/settings.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

// Catches: stale forms restoring grants, cross-project grant changes, or environment deletion removing sibling settings.
postgresTest(
  "repository identity changes revoke all grants and saves require the project's matching root environment",
  async ({ prisma }) => {
    const { project, organization } = await createTestOrgProjectWithMember(prisma);
    const other = await createTestOrgProjectWithMember(prisma);
    const production = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const preview = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PREVIEW",
    });
    const child = await prisma.runtimeEnvironment.create({
      data: {
        projectId: project.id,
        organizationId: organization.id,
        type: "PREVIEW",
        parentEnvironmentId: preview.id,
        branchName: "feature",
        slug: "preview-feature",
        shortcode: "preview-feature",
        apiKey: uniqueId("api"),
        pkApiKey: uniqueId("pk"),
      },
    });
    const foreign = await createRuntimeEnvironment(prisma, {
      projectId: other.project.id,
      organizationId: other.organization.id,
      type: "PRODUCTION",
    });
    const repository = {
      repositoryOwner: "example",
      repositoryName: "original",
      repositoryId: "123",
      repositoryOwnerId: "456",
    };
    await saveTrustedDeployRepository(project.id, repository, prisma);
    const originalRepository = await prisma.trustedDeployRepository.findFirstOrThrow({
      where: { projectId: project.id },
    });
    const policy = {
      repositoryUpdatedAt: originalRepository.updatedAt.toISOString(),
      scope: "BRANCH" as const,
      scopeValue: "main",
      additionalClaims: { environment: ["production"] },
    };
    await saveTrustedDeployEnvironment(
      project.id,
      {
        ...policy,
        runtimeEnvironmentId: production.id,
        type: "PRODUCTION",
      },
      prisma
    );
    await saveTrustedDeployEnvironment(
      project.id,
      {
        ...policy,
        runtimeEnvironmentId: preview.id,
        type: "PREVIEW",
      },
      prisma
    );

    for (const target of [
      { runtimeEnvironmentId: foreign.id, type: "PRODUCTION" as const },
      { runtimeEnvironmentId: child.id, type: "PREVIEW" as const },
      { runtimeEnvironmentId: preview.id, type: "PRODUCTION" as const },
    ]) {
      await expect(
        saveTrustedDeployEnvironment(project.id, { ...policy, ...target }, prisma)
      ).rejects.toBeInstanceOf(TrustedDeploySettingsError);
    }
    expect(await prisma.trustedDeployEnvironment.count()).toBe(2);
    expect(await prisma.trustedDeployEnvironment.count({ where: { enabled: true } })).toBe(2);
    await deleteTrustedDeployEnvironment(other.project.id, production.id, prisma);
    expect(await prisma.trustedDeployEnvironment.count()).toBe(2);

    const changed = { ...repository, repositoryName: "replacement", repositoryId: "789" };
    await expect(saveTrustedDeployRepository(project.id, changed, prisma)).resolves.toEqual({
      identityChanged: true,
    });
    expect(
      await prisma.trustedDeployRepository.findFirst({ where: { projectId: project.id } })
    ).toMatchObject({ repositoryName: "replacement", repositoryId: "789" });
    expect(await prisma.trustedDeployEnvironment.count({ where: { enabled: true } })).toBe(0);
    const savedGrants = await prisma.trustedDeployEnvironment.findMany();
    for (const grant of savedGrants) {
      expect(grant).toMatchObject({
        scope: policy.scope,
        scopeValue: policy.scopeValue,
        additionalClaims: policy.additionalClaims,
      });
    }

    await expect(
      saveTrustedDeployEnvironment(
        project.id,
        { ...policy, runtimeEnvironmentId: production.id, type: "PRODUCTION" },
        prisma
      )
    ).rejects.toThrow(
      "Repository settings changed. Reload and review the repository identity before saving this grant."
    );
    expect(await prisma.trustedDeployEnvironment.count({ where: { enabled: true } })).toBe(0);
    const currentRepository = await prisma.trustedDeployRepository.findFirstOrThrow({
      where: { projectId: project.id },
    });
    await saveTrustedDeployEnvironment(
      project.id,
      {
        ...policy,
        repositoryUpdatedAt: currentRepository.updatedAt.toISOString(),
        runtimeEnvironmentId: production.id,
        type: "PRODUCTION",
      },
      prisma
    );
    expect(
      await prisma.trustedDeployEnvironment.findFirst({
        where: { runtimeEnvironmentId: production.id },
      })
    ).toMatchObject({ enabled: true });
    expect(
      await prisma.trustedDeployEnvironment.findFirst({
        where: { runtimeEnvironmentId: preview.id },
      })
    ).toMatchObject({ enabled: false });

    await deleteTrustedDeployEnvironment(project.id, production.id, prisma);
    expect(
      await prisma.trustedDeployEnvironment.findFirst({
        where: { runtimeEnvironmentId: production.id },
      })
    ).toBeNull();
    expect(await prisma.trustedDeployEnvironment.count()).toBe(1);
    expect(await prisma.trustedDeployRepository.count()).toBe(1);
    await deleteTrustedDeployEnvironment(project.id, production.id, prisma);
    expect(await prisma.trustedDeployEnvironment.count()).toBe(1);

    await deleteTrustedDeployRepository(project.id, prisma);
    expect(await prisma.trustedDeployRepository.count()).toBe(0);
    expect(await prisma.trustedDeployEnvironment.count()).toBe(0);
  }
);
