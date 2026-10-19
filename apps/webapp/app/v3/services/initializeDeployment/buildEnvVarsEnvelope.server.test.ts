import { InitializeDeploymentRequestBody } from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import { decryptSecret } from "~/services/secrets/secretStore.server";
import { buildEnvVarsEnvelope } from "./buildEnvVarsEnvelope.server";

const encryptionKey = "0123456789abcdef0123456789abcdef";
const limits = { encryptionKey, maxKeys: 3, maxBytes: 128 };

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
  return JSON.parse(await decryptSecret(encryptionKey, envelope!));
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

  it("stores a redeploy source's envelope verbatim", async () => {
    const copyFrom = { nonce: "n", ciphertext: "c", tag: "t" };
    expect(
      await buildEnvVarsEnvelope(payload({ buildEnvVars: { IGNORED: "x" } }), {
        ...limits,
        copyFrom,
      })
    ).toBe(copyFrom);
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
