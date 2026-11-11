import {
  GITHUB_ACTIONS_ISSUER,
  TrustedDeployRepositorySettings,
  TrustedDeployPolicy,
} from "@trigger.dev/core/v3";
import type { z } from "zod/v4";
import { $transaction, prisma, type PrismaClientOrTransaction } from "~/db.server";

export async function getTrustedDeploySettings(projectId: string, environmentId: string) {
  const [repository, environment] = await Promise.all([
    prisma.trustedDeployRepository.findFirst({ where: { projectId } }),
    prisma.runtimeEnvironment.findFirst({
      where: {
        id: environmentId,
        projectId,
        parentEnvironmentId: null,
        archivedAt: null,
        type: { in: ["STAGING", "PREVIEW", "PRODUCTION"] },
      },
      select: {
        id: true,
        type: true,
        trustedDeployGrant: {
          select: {
            updatedAt: true,
            enabled: true,
            scope: true,
            scopeValue: true,
            additionalClaims: true,
          },
        },
      },
    }),
  ]);

  return {
    repository,
    environment,
  };
}

export async function saveTrustedDeployRepository(
  projectId: string,
  input: z.infer<typeof TrustedDeployRepositorySettings>,
  db: PrismaClientOrTransaction = prisma
) {
  const settings = TrustedDeployRepositorySettings.parse(input);
  const result = await $transaction(
    db,
    "saveTrustedDeployRepository",
    async (tx) => {
      const existing = await tx.trustedDeployRepository.findFirst({ where: { projectId } });
      const identityChanged = Boolean(
        existing &&
        (existing.issuer !== GITHUB_ACTIONS_ISSUER ||
          existing.repositoryOwner !== settings.repositoryOwner ||
          existing.repositoryName !== settings.repositoryName ||
          existing.repositoryId !== (settings.repositoryId ?? null) ||
          existing.repositoryOwnerId !== (settings.repositoryOwnerId ?? null))
      );
      const data = {
        ...settings,
        repositoryId: settings.repositoryId ?? null,
        repositoryOwnerId: settings.repositoryOwnerId ?? null,
        issuer: GITHUB_ACTIONS_ISSUER,
      };
      const repository = await tx.trustedDeployRepository.upsert({
        where: { projectId },
        create: { projectId, ...data },
        update: data,
      });
      if (identityChanged) {
        await tx.trustedDeployEnvironment.updateMany({
          where: { trustedDeployRepositoryId: repository.id },
          data: { enabled: false },
        });
      }
      return { identityChanged };
    },
    { isolationLevel: "Serializable" }
  );
  if (!result) throw new Error("Could not save trusted repository.");
  return result;
}

export async function deleteTrustedDeployRepository(
  projectId: string,
  db: PrismaClientOrTransaction = prisma
) {
  await db.trustedDeployRepository.deleteMany({ where: { projectId } });
}

export async function deleteTrustedDeployEnvironment(
  projectId: string,
  runtimeEnvironmentId: string,
  db: PrismaClientOrTransaction = prisma
) {
  await db.trustedDeployEnvironment.deleteMany({
    where: {
      runtimeEnvironmentId,
      runtimeEnvironment: { projectId, parentEnvironmentId: null },
      trustedDeployRepository: { projectId },
    },
  });
}

export class TrustedDeploySettingsError extends Error {}

export async function saveTrustedDeployEnvironment(
  projectId: string,
  input: {
    runtimeEnvironmentId: string;
    repositoryUpdatedAt: string;
    type: "STAGING" | "PREVIEW" | "PRODUCTION";
  } & z.input<typeof TrustedDeployPolicy>,
  db: PrismaClientOrTransaction = prisma
) {
  const policy = TrustedDeployPolicy.parse(input);
  const result = await $transaction(
    db,
    "saveTrustedDeployEnvironment",
    async (tx) => {
      const environment = await tx.runtimeEnvironment.findFirst({
        where: {
          id: input.runtimeEnvironmentId,
          projectId,
          type: input.type,
          parentEnvironmentId: null,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!environment) {
        throw new TrustedDeploySettingsError(
          "Environment not found. Enable it from the environment menu first."
        );
      }
      const repository = await tx.trustedDeployRepository.findFirst({ where: { projectId } });
      if (!repository) throw new TrustedDeploySettingsError("Save the repository first.");
      if (input.repositoryUpdatedAt !== repository.updatedAt.toISOString()) {
        throw new TrustedDeploySettingsError(
          "Repository settings changed. Reload and review the repository identity before saving this grant."
        );
      }
      const data = {
        enabled: true,
        ...policy,
      };
      await tx.trustedDeployEnvironment.upsert({
        select: { id: true },
        where: { runtimeEnvironmentId: environment.id },
        create: {
          runtimeEnvironmentId: environment.id,
          trustedDeployRepositoryId: repository.id,
          ...data,
        },
        update: data,
      });
      return { saved: true };
    },
    { isolationLevel: "Serializable" }
  );
  if (!result) throw new Error("Could not save trusted deploy grant.");
}
