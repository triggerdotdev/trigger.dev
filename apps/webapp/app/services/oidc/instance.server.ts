import { $transaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import { getSecretStore, isAwsKmsSecretStoreEnabled } from "~/services/secrets/secretStore.server";
import { singleton } from "~/utils/singleton";
import { OidcSigningKeyService } from "./signingKeyService.server";

export const oidcSigningKeyService = singleton(
  "oidcSigningKeyService",
  () =>
    new OidcSigningKeyService({
      db: prisma,
      issuer: env.OIDC_ISSUER_URL,
      secretStore: (db) =>
        getSecretStore(isAwsKmsSecretStoreEnabled() ? "AWS_KMS" : "DATABASE", {
          prismaClient: db,
        }),
      runTransaction: async (name, fn) => {
        const result = await $transaction(prisma, name, async (tx) => ({ value: await fn(tx) }));
        if (result === undefined) {
          throw new Error(`OIDC signing key transaction did not return a result: ${name}`);
        }
        return result.value;
      },
    })
);
