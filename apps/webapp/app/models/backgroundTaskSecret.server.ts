import { BackgroundTaskVersion } from "@trigger.dev/database";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { SecretStore, getSecretStore } from "~/services/secrets/secretStore.server";

export async function createBackgroundTaskSecret(
  prisma: PrismaClientOrTransaction,
  version: BackgroundTaskVersion,
  key: string,
  value: string
) {
  const secretKey = `${version.environmentId}:${key}`;

  return await $transaction(prisma, async (tx) => {
    const newSecret = await tx.backgroundTaskSecret.create({
      data: {
        key,
        backgroundTaskVersion: {
          connect: {
            id: version.id,
          },
        },
        secretReference: {
          connectOrCreate: {
            where: {
              key: secretKey,
            },
            create: {
              key: secretKey,
              provider: "DATABASE",
            },
          },
        },
      },
      include: {
        secretReference: true,
      },
    });

    const secretStoreProvider = getSecretStore("DATABASE", { prismaClient: tx });
    const secretStore = new SecretStore(secretStoreProvider);

    await secretStore.setSecret(secretKey, { secret: value });

    return newSecret;
  });
}

export async function updateBackgroundTaskSecret(
  prisma: PrismaClientOrTransaction,
  version: BackgroundTaskVersion,
  key: string,
  value: string
) {
  const secretKey = `${version.environmentId}:${key}`;

  return await $transaction(prisma, async (tx) => {
    const updatedSecret = await tx.backgroundTaskSecret.upsert({
      where: {
        backgroundTaskVersionId_key: {
          backgroundTaskVersionId: version.id,
          key,
        },
      },
      create: {
        key,
        backgroundTaskVersion: {
          connect: {
            id: version.id,
          },
        },
        secretReference: {
          connectOrCreate: {
            where: {
              key: secretKey,
            },
            create: {
              key: secretKey,
              provider: "DATABASE",
            },
          },
        },
      },
      update: {},
      include: {
        secretReference: true,
      },
    });

    const secretStoreProvider = getSecretStore("DATABASE", { prismaClient: tx });
    const secretStore = new SecretStore(secretStoreProvider);

    await secretStore.setSecret(secretKey, { secret: value });

    return updatedSecret;
  });
}

export async function deleteBackgroundTaskSecret(prisma: PrismaClientOrTransaction, id: string) {
  return await $transaction(prisma, async (tx) => {
    const secret = await tx.backgroundTaskSecret.delete({
      where: {
        id,
      },
      include: {
        secretReference: true,
      },
    });

    if (!secret) {
      return;
    }

    const secretStoreProvider = getSecretStore("DATABASE", { prismaClient: tx });
    const secretStore = new SecretStore(secretStoreProvider);

    await secretStore.deleteSecret(secret.secretReference.key);
  });
}
