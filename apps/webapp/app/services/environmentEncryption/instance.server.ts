import { prisma, $replica, $transaction, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { EnvironmentEncryptionService } from "./service.server";

const services = new WeakMap<PrismaClientOrTransaction, EnvironmentEncryptionService>();

export function environmentEncryption(
  db: PrismaClientOrTransaction = prisma
): EnvironmentEncryptionService {
  if (db === prisma || db === $replica)
    return singleton("environmentEncryption", () => createService(prisma));
  if (!("$transaction" in db))
    throw new Error("Environment encryption requires a writer client, not a transaction");
  let service = services.get(db);
  if (!service) {
    service = createService(db);
    services.set(db, service);
  }
  return service;
}

function createService(db: PrismaClientOrTransaction) {
  return new EnvironmentEncryptionService({
    db,
    transaction: (fn) => $transaction(db, "environment encryption", fn),
    keyring: env.ENCRYPTION_KEYRING,
    writesEnabled: env.ENVIRONMENT_ENCRYPTION_ENABLED,
    defaultWrappingPolicy: {
      wrappingProvider: env.ENVIRONMENT_ENCRYPTION_KMS_KEY_ARN ? "AWS_KMS" : "PLATFORM_KEYRING",
      wrappingKeyReference:
        env.ENVIRONMENT_ENCRYPTION_KMS_KEY_ARN ?? env.ENCRYPTION_KEYRING.activeKeyId,
    },
  });
}
