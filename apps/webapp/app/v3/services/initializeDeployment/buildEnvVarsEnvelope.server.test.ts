import { InitializeDeploymentRequestBody } from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "~/services/secrets/secretStore.server";
import {
  EncryptedValueSchema,
  encryptValue,
  parseEncryptionKeyring,
  resolveEncryptionKeyring,
} from "~/utils/encryptionKeyring.server";
import { buildEnvVarsEnvelope } from "./buildEnvVarsEnvelope.server";

const legacyKey = "0123456789abcdef0123456789abcdef";
const encryptionKey = resolveEncryptionKeyring(undefined, legacyKey);
const limits = {
  encrypt: (plaintext: string) => encryptValue(plaintext, encryptionKey),
  maxKeys: 3,
  maxBytes: 128,
};

function payload(overrides: Record<string, unknown> = {}) {
  return InitializeDeploymentRequestBody.parse({
    contentHash: "hash",
    type: "MANAGED",
    isNativeBuild: true,
    artifactKey: "bundles/proj_ref/prod/abc.tar.gz",
    fromBundle: true,
    ...overrides,
  });
}

async function decrypted(envelope: Awaited<ReturnType<typeof buildEnvVarsEnvelope>>) {
  expect(envelope).toBeDefined();
  return JSON.parse(await decryptSecret(encryptionKey, EncryptedValueSchema.parse(envelope)));
}

describe("buildEnvVarsEnvelope", () => {
  it("encrypts a bundle deploy's build env vars", async () => {
    const vars = { DATABASE_URL: "postgres://build" };
    expect(
      await decrypted(await buildEnvVarsEnvelope(payload({ buildEnvVars: vars }), limits))
    ).toEqual(vars);
  });

  it("stores an empty envelope for a bundle deploy without build env vars", async () => {
    expect(await decrypted(await buildEnvVarsEnvelope(payload(), limits))).toEqual({});
  });

  // Catches: redeploy copying old-key ciphertext back after rotation.
  it("re-encrypts a redeploy source with the active key, preserving its variables", async () => {
    const variables = { ORIGINAL: "value" };
    const copyFrom = await encryptSecret(encryptionKey, JSON.stringify(variables));
    const keyring = parseEncryptionKeyring(
      JSON.stringify({
        activeKeyId: "v2",
        keys: { legacy: legacyKey, v2: "abcdef0123456789abcdef0123456789" },
      })
    );
    const result = await buildEnvVarsEnvelope(payload({ buildEnvVars: { IGNORED: "x" } }), {
      ...limits,
      encrypt: (plaintext) => encryptValue(plaintext, keyring),
      decryptSource: (value) => decryptSecret(keyring, EncryptedValueSchema.parse(value)),
      copyFrom,
    });
    expect(result?.keyId).toBe("v2");
    expect(JSON.parse(await decryptSecret(keyring, EncryptedValueSchema.parse(result)))).toEqual(
      variables
    );
  });

  it("stores nothing for a source upload", async () => {
    expect(
      await buildEnvVarsEnvelope(
        payload({ fromBundle: undefined, buildEnvVars: { A: "1" } }),
        limits
      )
    ).toBeUndefined();
  });
});
