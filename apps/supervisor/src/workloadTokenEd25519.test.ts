import { generateKeyPairSync } from "node:crypto";
import {
  mintWorkloadDeploymentToken,
  type WorkloadDeploymentTokenInput,
} from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import {
  classifyDeploymentIdHeaderWithKeySet,
  mintWorkloadDeploymentTokenEd25519,
  parseWorkloadTokenPublicKeys,
  parseWorkloadTokenSecrets,
  verifyWorkloadDeploymentTokenWithKeySet,
} from "./workloadTokenEd25519.js";

const SECRET = "test-workload-token-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);

const claims: WorkloadDeploymentTokenInput = {
  deployment: "deployment_abc123",
  deployment_version: "20260709.1",
  environment_id: "env_1",
  environment_type: "PRODUCTION",
  org_id: "org_1",
  project_id: "proj_1",
};

function generateEd25519Pems(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("ed25519 signing", () => {
  const first = generateEd25519Pems();
  const second = generateEd25519Pems();

  it("mints with the private key and verifies with the public key", async () => {
    const token = mintWorkloadDeploymentTokenEd25519(claims, first.privateKey, EXP);

    const result = await verifyWorkloadDeploymentTokenWithKeySet(token, {
      publicKeys: [first.publicKey],
      hmacSecrets: [],
    });

    expect(result).toMatchObject({ ok: true, match: { kind: "public_key", index: 0 } });
    if (!result.ok) return;
    expect(result.claims.deployment).toBe(claims.deployment);
    expect(result.claims.exp).toBe(EXP);
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString())).toEqual({
      alg: "EdDSA",
      typ: "JWT",
    });
  });

  it("mints byte-identical tokens for identical claims", () => {
    const a = mintWorkloadDeploymentTokenEd25519(claims, first.privateKey, EXP);
    const b = mintWorkloadDeploymentTokenEd25519(claims, first.privateKey, EXP);
    expect(a).toBe(b);
  });

  it("reports the index of a staged public key", async () => {
    const token = mintWorkloadDeploymentTokenEd25519(claims, second.privateKey, EXP);

    const result = await verifyWorkloadDeploymentTokenWithKeySet(token, {
      publicKeys: [first.publicKey, second.publicKey],
      hmacSecrets: [],
    });

    expect(result).toMatchObject({ ok: true, match: { kind: "public_key", index: 1 } });
  });

  it("verifies an HS256 token through the HMAC fallback", async () => {
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);

    const result = await verifyWorkloadDeploymentTokenWithKeySet(token, {
      publicKeys: [first.publicKey],
      hmacSecrets: ["other-secret", SECRET],
    });

    expect(result).toMatchObject({ ok: true, match: { kind: "hmac_secret", index: 1 } });
  });

  it("rejects a token signed by a different ed25519 key", async () => {
    const token = mintWorkloadDeploymentTokenEd25519(claims, second.privateKey, EXP);

    const result = await verifyWorkloadDeploymentTokenWithKeySet(token, {
      publicKeys: [first.publicKey],
      hmacSecrets: [SECRET],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects an HS256 token signed with the public key PEM as the secret", async () => {
    const token = await mintWorkloadDeploymentToken(claims, first.publicKey, EXP);

    const result = await verifyWorkloadDeploymentTokenWithKeySet(token, {
      publicKeys: [first.publicKey],
      hmacSecrets: [],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects an ed25519 token when only HMAC secrets are configured", async () => {
    const token = mintWorkloadDeploymentTokenEd25519(claims, first.privateKey, EXP);

    const result = await verifyWorkloadDeploymentTokenWithKeySet(token, {
      publicKeys: [],
      hmacSecrets: [SECRET],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects an expired ed25519 token", async () => {
    const token = mintWorkloadDeploymentTokenEd25519(claims, first.privateKey, 1);

    const result = await verifyWorkloadDeploymentTokenWithKeySet(token, {
      publicKeys: [first.publicKey],
      hmacSecrets: [],
    });

    expect(result.ok).toBe(false);
  });

  it("classifies ed25519 tokens through the key set", async () => {
    const token = mintWorkloadDeploymentTokenEd25519(claims, first.privateKey, EXP);

    const result = await classifyDeploymentIdHeaderWithKeySet(token, {
      publicKeys: [first.publicKey],
      hmacSecrets: [],
    });

    expect(result.outcome).toBe("jwt_valid");
    expect(result.match).toEqual({ kind: "public_key", index: 0 });
  });
});

const FIXTURE_PRIVATE_KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIN7KTxv6yD6UW1CUV7pfoz7T3/GFHR31IAI7g0vQEkxa\n-----END PRIVATE KEY-----\n";
const FIXTURE_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVXkm3hCsO1nD6EcyMD2mlJqJ0gHroEVu4ld54TYFeno=\n-----END PUBLIC KEY-----\n";
const FIXTURE_EXP = 4070908800;
const FIXTURE_CLAIMS: WorkloadDeploymentTokenInput = {
  deployment: "deployment_fixture_1",
  deployment_version: "20990101.1",
  environment_id: "env_fixture_1",
  environment_type: "PRODUCTION",
  org_id: "org_fixture_1",
  project_id: "proj_fixture_1",
};
const FIXTURE_TOKEN =
  "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJ2ZXIiOjEsImRlcGxveW1lbnQiOiJkZXBsb3ltZW50X2ZpeHR1cmVfMSIsImRlcGxveW1lbnRfdmVyc2lvbiI6IjIwOTkwMTAxLjEiLCJlbnZpcm9ubWVudF9pZCI6ImVudl9maXh0dXJlXzEiLCJlbnZpcm9ubWVudF90eXBlIjoiUFJPRFVDVElPTiIsIm9yZ19pZCI6Im9yZ19maXh0dXJlXzEiLCJwcm9qZWN0X2lkIjoicHJval9maXh0dXJlXzEiLCJpc3MiOiJodHRwczovL2lkLnRyaWdnZXIuZGV2IiwiYXVkIjoiaHR0cHM6Ly9hcGkudHJpZ2dlci5kZXYiLCJleHAiOjQwNzA5MDg4MDB9.xSPDqn3rH3m6sSl2tGzmDNUkhz-3Dc5THacRzOZyxA-ift4W6j_D-VYJn6v6_rDpGC_4bvRZbpxaurrSQoHTCw";

describe("frozen ed25519 token fixture", () => {
  it("mints exactly the fixture token", () => {
    expect(
      mintWorkloadDeploymentTokenEd25519(FIXTURE_CLAIMS, FIXTURE_PRIVATE_KEY_PEM, FIXTURE_EXP)
    ).toBe(FIXTURE_TOKEN);
  });

  it("verifies the fixture token with the fixture public key", async () => {
    const result = await verifyWorkloadDeploymentTokenWithKeySet(FIXTURE_TOKEN, {
      publicKeys: [FIXTURE_PUBLIC_KEY_PEM],
      hmacSecrets: [],
    });

    expect(result).toMatchObject({ ok: true, match: { kind: "public_key", index: 0 } });
    if (!result.ok) return;
    expect(result.claims).toMatchObject({ ...FIXTURE_CLAIMS, exp: FIXTURE_EXP });
  });
});

describe("parseWorkloadTokenPublicKeys", () => {
  const first = generateEd25519Pems().publicKey;
  const second = generateEd25519Pems().publicKey;

  it("returns nothing for unset and blank input", () => {
    expect(parseWorkloadTokenPublicKeys(undefined)).toEqual([]);
    expect(parseWorkloadTokenPublicKeys("")).toEqual([]);
    expect(parseWorkloadTokenPublicKeys("  \n ")).toEqual([]);
  });

  it("parses one entry without a cutoff", () => {
    const raw = JSON.stringify([{ publicKey: first }]);
    expect(parseWorkloadTokenPublicKeys(raw)).toEqual([{ publicKey: first.trim() }]);
  });

  it("parses entries in order with their own cutoffs", () => {
    const raw = ` ${JSON.stringify([
      { publicKey: first },
      { publicKey: second, runCutoff: "2026-11-20T00:00:00Z" },
    ])} \n`;
    expect(parseWorkloadTokenPublicKeys(raw)).toEqual([
      { publicKey: first.trim() },
      { publicKey: second.trim(), runCutoff: "2026-11-20T00:00:00Z" },
    ]);
  });

  it("parses an empty array", () => {
    expect(parseWorkloadTokenPublicKeys("[]")).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseWorkloadTokenPublicKeys("not json")).toThrow(/^WORKLOAD_TOKEN_PUBLIC_KEYS/);
    expect(() => parseWorkloadTokenPublicKeys(first)).toThrow(/^WORKLOAD_TOKEN_PUBLIC_KEYS/);
  });

  it("throws when the value is not an array", () => {
    expect(() => parseWorkloadTokenPublicKeys(JSON.stringify({ publicKey: first }))).toThrow(
      /^WORKLOAD_TOKEN_PUBLIC_KEYS/
    );
    expect(() => parseWorkloadTokenPublicKeys(JSON.stringify(first))).toThrow(
      /^WORKLOAD_TOKEN_PUBLIC_KEYS/
    );
  });

  it("throws on a bad entry shape", () => {
    expect(() => parseWorkloadTokenPublicKeys(JSON.stringify([{}]))).toThrow(
      /^WORKLOAD_TOKEN_PUBLIC_KEYS/
    );
    expect(() => parseWorkloadTokenPublicKeys(JSON.stringify([first]))).toThrow(
      /^WORKLOAD_TOKEN_PUBLIC_KEYS/
    );
  });

  it("throws on a bad runCutoff", () => {
    const raw = JSON.stringify([{ publicKey: first, runCutoff: "next tuesday" }]);
    expect(() => parseWorkloadTokenPublicKeys(raw)).toThrow(/^WORKLOAD_TOKEN_PUBLIC_KEYS/);
  });

  it("throws when a publicKey is not a PEM public key", () => {
    const raw = JSON.stringify([{ publicKey: "not a key" }]);
    expect(() => parseWorkloadTokenPublicKeys(raw)).toThrow(/^WORKLOAD_TOKEN_PUBLIC_KEYS/);
  });

  it("throws on an unknown entry key such as a misspelled runCutoff", () => {
    const raw = JSON.stringify([{ publicKey: first, runCutOff: "2026-11-20T00:00:00Z" }]);
    expect(() => parseWorkloadTokenPublicKeys(raw)).toThrow(/^WORKLOAD_TOKEN_PUBLIC_KEYS/);
  });
});

describe("parseWorkloadTokenSecrets", () => {
  it("returns nothing for unset and blank input", () => {
    expect(parseWorkloadTokenSecrets(undefined)).toEqual([]);
    expect(parseWorkloadTokenSecrets("")).toEqual([]);
    expect(parseWorkloadTokenSecrets("  \n ")).toEqual([]);
  });

  it("parses a plain secret", () => {
    expect(parseWorkloadTokenSecrets("alpha")).toEqual([{ secret: "alpha" }]);
  });

  it("splits at the first colon so the cutoff keeps its own colons", () => {
    expect(parseWorkloadTokenSecrets("alpha:2026-11-20T00:00:00Z")).toEqual([
      { secret: "alpha", runCutoff: "2026-11-20T00:00:00Z" },
    ]);
    expect(parseWorkloadTokenSecrets("alpha:2026-11-20T10:30:45.123Z")).toEqual([
      { secret: "alpha", runCutoff: "2026-11-20T10:30:45.123Z" },
    ]);
  });

  it("parses several entries in order", () => {
    expect(parseWorkloadTokenSecrets("alpha,beta:2026-11-20T00:00:00Z,gamma")).toEqual([
      { secret: "alpha" },
      { secret: "beta", runCutoff: "2026-11-20T00:00:00Z" },
      { secret: "gamma" },
    ]);
  });

  it("trims whitespace around entries", () => {
    expect(parseWorkloadTokenSecrets("  alpha , beta:2026-11-20T00:00:00Z \n")).toEqual([
      { secret: "alpha" },
      { secret: "beta", runCutoff: "2026-11-20T00:00:00Z" },
    ]);
  });

  it("throws on a bad cutoff", () => {
    expect(() => parseWorkloadTokenSecrets("alpha:tomorrow")).toThrow(/^WORKLOAD_TOKEN_SECRETS/);
    expect(() => parseWorkloadTokenSecrets("alpha:")).toThrow(/^WORKLOAD_TOKEN_SECRETS/);
    expect(() => parseWorkloadTokenSecrets("alpha:2026-11-20")).toThrow(/^WORKLOAD_TOKEN_SECRETS/);
  });

  it("throws on an empty entry", () => {
    expect(() => parseWorkloadTokenSecrets("alpha,,beta")).toThrow(/^WORKLOAD_TOKEN_SECRETS/);
    expect(() => parseWorkloadTokenSecrets("alpha,")).toThrow(/^WORKLOAD_TOKEN_SECRETS/);
    expect(() => parseWorkloadTokenSecrets(",alpha")).toThrow(/^WORKLOAD_TOKEN_SECRETS/);
  });

  it("throws on an empty secret before the colon", () => {
    expect(() => parseWorkloadTokenSecrets(":2026-11-20T00:00:00Z")).toThrow(
      /^WORKLOAD_TOKEN_SECRETS/
    );
  });
});
