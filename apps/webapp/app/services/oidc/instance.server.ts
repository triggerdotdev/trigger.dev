import type { OidcSigningKeyPurpose } from "@trigger.dev/database";
import { $transaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import { getSecretStore, isAwsKmsSecretStoreEnabled } from "~/services/secrets/secretStore.server";
import { singleton } from "~/utils/singleton";
import { OidcSigningKeyService } from "./signingKeyService.server";

function createSigningKeyService(purpose: OidcSigningKeyPurpose, issuer: string | undefined) {
  return new OidcSigningKeyService({
    db: prisma,
    purpose,
    issuer,
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
  });
}

/** Signs tokens for external relying parties. Its public keys are served at the issuer's JWKS. */
export const externalOidcSigningService = singleton("externalOidcSigningService", () =>
  createSigningKeyService("EXTERNAL_OIDC", env.OIDC_ISSUER_URL)
);

/** Signs per-attempt run tokens. Its public keys are only used in-process and never served. */
export const internalRunSigningService = singleton("internalRunSigningService", () =>
  createSigningKeyService("INTERNAL_RUN", env.RUN_TOKEN_ISSUER_URL)
);

export function signingServiceFor(purpose: OidcSigningKeyPurpose): OidcSigningKeyService {
  return purpose === "INTERNAL_RUN" ? internalRunSigningService : externalOidcSigningService;
}
