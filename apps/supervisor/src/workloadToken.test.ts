import { generateKeyPairSync } from "node:crypto";
import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import {
  generateFriendlyId,
  generateRunOpsId,
  generateRunOpsIdV2,
  parseRunId,
} from "@trigger.dev/core/v3/isomorphic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintWorkloadDeploymentTokenEd25519 } from "./workloadTokenEd25519.js";

const SECRET = "current-secret";
const PREVIOUS_SECRET = "previous-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);
const CUTOFF_ISO = "2026-06-01T00:00:00.000Z";
const CUTOFF_MS = Date.parse(CUTOFF_ISO);

const claims = {
  deployment: "deployment_test",
  deployment_version: "20260710.1",
  environment_id: "env_1",
  environment_type: "PRODUCTION",
  org_id: "org_1",
  project_id: "proj_1",
};

function publicKeysEnv(entries: { publicKey: string; runCutoff?: string }[]) {
  return JSON.stringify(entries);
}

async function loadWorkloadToken(extraEnv: Record<string, string>) {
  vi.resetModules();
  vi.doMock("std-env", () => ({
    env: {
      TRIGGER_API_URL: "http://localhost:3030",
      TRIGGER_WORKER_TOKEN: "test-token",
      MANAGED_WORKER_SECRET: "test-secret",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      WORKLOAD_TOKEN_SECRET: SECRET,
      WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
      ...extraEnv,
    },
  }));
  return import("./workloadToken.js");
}

function runIdCreatedAt(ms: number) {
  const now = vi.spyOn(Date, "now").mockReturnValue(ms);
  try {
    return `run_${generateRunOpsId("us-east-1")}`;
  } finally {
    now.mockRestore();
  }
}

function gen2RunIdCreatedAt(ms: number) {
  const now = vi.spyOn(Date, "now").mockReturnValue(ms);
  try {
    return `run_${generateRunOpsIdV2("a")}`;
  } finally {
    now.mockRestore();
  }
}

afterEach(() => {
  vi.doUnmock("std-env");
});

describe("verifyDeploymentIdHeader key selection", () => {
  it("verifies a current-key token as key current", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);

    const result = await verifyDeploymentIdHeader(token, "http");

    expect(result).toMatchObject({ outcome: "jwt_valid", key: "current" });
  });

  it("verifies a previous-key token as key previous", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const token = await mintWorkloadDeploymentToken(claims, PREVIOUS_SECRET, EXP);

    const result = await verifyDeploymentIdHeader(token, "http");

    expect(result).toMatchObject({ outcome: "jwt_valid", key: "previous", claims });
  });

  it("rejects a token signed with neither key", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const token = await mintWorkloadDeploymentToken(claims, "other-secret", EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toEqual({ outcome: "jwt_invalid" });
  });

  it("ignores an empty previous secret", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: "",
    });
    const token = await mintWorkloadDeploymentToken(claims, "", EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toEqual({ outcome: "jwt_invalid" });
  });

  it("treats a previous secret equal to the current one as unset", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: SECRET,
    });
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toMatchObject({
      outcome: "jwt_valid",
      key: "current",
    });
  });
});

describe("WORKLOAD_TOKEN_SECRETS", () => {
  it("verifies an entry without a cutoff as current", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRETS: "listed-secret",
    });
    const token = await mintWorkloadDeploymentToken(claims, "listed-secret", EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toMatchObject({
      outcome: "jwt_valid",
      key: "current",
    });
  });

  it("keeps WORKLOAD_TOKEN_SECRET current alongside the list, with duplicates harmless", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRETS: `${SECRET},listed-secret`,
    });

    expect(
      await verifyDeploymentIdHeader(await mintWorkloadDeploymentToken(claims, SECRET, EXP), "http")
    ).toMatchObject({ outcome: "jwt_valid", key: "current" });
    expect(
      await verifyDeploymentIdHeader(
        await mintWorkloadDeploymentToken(claims, "listed-secret", EXP),
        "http"
      )
    ).toMatchObject({ outcome: "jwt_valid", key: "current" });
  });

  it("verifies an entry with a cutoff as previous with its own runCutoffMs", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRETS: `cut-secret:${CUTOFF_ISO}`,
    });
    const token = await mintWorkloadDeploymentToken(claims, "cut-secret", EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toMatchObject({
      outcome: "jwt_valid",
      key: "previous",
      runCutoffMs: CUTOFF_MS,
    });
  });

  it("gives each cut entry its own cutoff and keeps the legacy previous secret under the global cutoff", async () => {
    const otherCutoffIso = "2026-09-01T00:00:00.000Z";
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRETS: `cut-a:${CUTOFF_ISO},cut-b:${otherCutoffIso}`,
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
      WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-07-01T00:00:00.000Z",
    });

    const cutoffFor = async (secret: string) => {
      const result = await verifyDeploymentIdHeader(
        await mintWorkloadDeploymentToken(claims, secret, EXP),
        "http"
      );
      expect(result).toMatchObject({ outcome: "jwt_valid", key: "previous" });
      return result.runCutoffMs;
    };

    expect(await cutoffFor("cut-a")).toBe(CUTOFF_MS);
    expect(await cutoffFor("cut-b")).toBe(Date.parse(otherCutoffIso));
    expect(await cutoffFor(PREVIOUS_SECRET)).toBe(Date.parse("2026-07-01T00:00:00.000Z"));
  });
});

describe("checkPreviousKeyRunCutoff", () => {
  it("passes every run when no cutoff is given", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });

    expect(checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2030, 0, 1)), undefined)).toBe("pass");
  });

  it("passes runs created before the cutoff, fails runs at or after it", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });

    expect(checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2026, 4, 31)), CUTOFF_MS)).toBe(
      "pass"
    );
    expect(checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2026, 5, 1)), CUTOFF_MS)).toBe("fail");
    expect(checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2026, 9, 1)), CUTOFF_MS)).toBe("fail");
  });

  it("passes every legacy run id shape when a cutoff is given", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const nanoid = generateFriendlyId("run");
    const base62 = "run_2xK9mQ7vRtZ4bN8cW1pL5sYfH0j";

    expect(nanoid).toMatch(/^run_[1-9a-km-z]{21}$/);
    expect(base62.length - "run_".length).toBe(27);
    expect(parseRunId(nanoid).format).toBe("legacy");
    expect(parseRunId(base62).format).toBe("legacy");

    expect(checkPreviousKeyRunCutoff(nanoid, CUTOFF_MS)).toBe("pass");
    expect(checkPreviousKeyRunCutoff(base62, CUTOFF_MS)).toBe("pass");
    expect(checkPreviousKeyRunCutoff("run_cm1legacy0000000000000", CUTOFF_MS)).toBe("pass");
  });

  it("fails a non-string run id instead of throwing, with or without a cutoff", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });

    expect(checkPreviousKeyRunCutoff(123, undefined)).toBe("fail");
    expect(checkPreviousKeyRunCutoff(undefined, undefined)).toBe("fail");
    expect(checkPreviousKeyRunCutoff(123, CUTOFF_MS)).toBe("fail");
    expect(checkPreviousKeyRunCutoff(undefined, CUTOFF_MS)).toBe("fail");
  });

  it("applies the cutoff to gen-2 run ids", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const before = gen2RunIdCreatedAt(Date.UTC(2026, 4, 31));
    const after = gen2RunIdCreatedAt(Date.UTC(2026, 9, 1));

    expect(parseRunId(before).format).toBe("b32hexV2");
    expect(parseRunId(after).format).toBe("b32hexV2");

    expect(checkPreviousKeyRunCutoff(before, CUTOFF_MS)).toBe("pass");
    expect(checkPreviousKeyRunCutoff(after, CUTOFF_MS)).toBe("fail");
  });

  it("fails an id without the run_ prefix, even one that parseRunId calls legacy", async () => {
    const { checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const postCutoffBody = runIdCreatedAt(Date.UTC(2026, 9, 1)).slice("run_".length);

    expect(checkPreviousKeyRunCutoff(`x_${postCutoffBody}`, CUTOFF_MS)).toBe("fail");
    expect(checkPreviousKeyRunCutoff(postCutoffBody, CUTOFF_MS)).toBe("fail");
    expect(checkPreviousKeyRunCutoff("x_cm1legacy0000000000000", CUTOFF_MS)).toBe("fail");
    expect(checkPreviousKeyRunCutoff("run_cm1legacy0000000000000", CUTOFF_MS)).toBe("pass");
  });
});

function generateEd25519Pems(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("ed25519 deployment tokens", () => {
  const first = generateEd25519Pems();
  const second = generateEd25519Pems();
  const stranger = generateEd25519Pems();

  it("mints with the signing key and verifies as key current", async () => {
    const { mintDeploymentToken, verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SIGNING_KEY: first.privateKey,
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([{ publicKey: first.publicKey }]),
    });

    const token = await mintDeploymentToken(claims);

    expect(token).toBeDefined();
    expect(await verifyDeploymentIdHeader(token, "http")).toMatchObject({
      outcome: "jwt_valid",
      key: "current",
      claims: expect.objectContaining({ deployment: claims.deployment }),
    });
  });

  it("mints identical tokens for identical claims", async () => {
    const { mintDeploymentToken } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SIGNING_KEY: first.privateKey,
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([{ publicKey: first.publicKey }]),
    });

    expect(await mintDeploymentToken(claims)).toBe(await mintDeploymentToken(claims));
  });

  it("mints HS256 with the secret when no signing key is set", async () => {
    const { mintDeploymentToken } = await loadWorkloadToken({});

    const token = await mintDeploymentToken(claims);

    expect(token).toBe(await mintWorkloadDeploymentToken(claims, SECRET, EXP));
  });

  it("treats an entry without runCutoff as current and one with runCutoff as previous", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([
        { publicKey: first.publicKey },
        { publicKey: second.publicKey, runCutoff: CUTOFF_ISO },
      ]),
    });
    const byFirst = await mintWorkloadDeploymentTokenEd25519(claims, first.privateKey, EXP);
    const bySecond = await mintWorkloadDeploymentTokenEd25519(claims, second.privateKey, EXP);

    const currentResult = await verifyDeploymentIdHeader(byFirst, "http");
    const previousResult = await verifyDeploymentIdHeader(bySecond, "http");

    expect(currentResult).toMatchObject({ outcome: "jwt_valid", key: "current" });
    expect(currentResult).not.toHaveProperty("runCutoffMs");
    expect(previousResult).toMatchObject({
      outcome: "jwt_valid",
      key: "previous",
      runCutoffMs: CUTOFF_MS,
    });
  });

  it("does not depend on entry order to pick the current key", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([
        { publicKey: first.publicKey, runCutoff: CUTOFF_ISO },
        { publicKey: second.publicKey },
      ]),
    });
    const byFirst = await mintWorkloadDeploymentTokenEd25519(claims, first.privateKey, EXP);
    const bySecond = await mintWorkloadDeploymentTokenEd25519(claims, second.privateKey, EXP);

    expect(await verifyDeploymentIdHeader(byFirst, "http")).toMatchObject({ key: "previous" });
    expect(await verifyDeploymentIdHeader(bySecond, "http")).toMatchObject({ key: "current" });
  });

  it("gates each previous public key by its own cutoff", async () => {
    const earlier = "2026-03-01T00:00:00.000Z";
    const later = "2026-09-01T00:00:00.000Z";
    const { verifyDeploymentIdHeader, checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([
        { publicKey: first.publicKey },
        { publicKey: second.publicKey, runCutoff: earlier },
        { publicKey: stranger.publicKey, runCutoff: later },
      ]),
    });
    const bySecond = await mintWorkloadDeploymentTokenEd25519(claims, second.privateKey, EXP);
    const byStranger = await mintWorkloadDeploymentTokenEd25519(claims, stranger.privateKey, EXP);
    const midRun = runIdCreatedAt(Date.UTC(2026, 5, 1));

    const secondResult = await verifyDeploymentIdHeader(bySecond, "http");
    const strangerResult = await verifyDeploymentIdHeader(byStranger, "http");

    expect(secondResult).toMatchObject({ key: "previous", runCutoffMs: Date.parse(earlier) });
    expect(strangerResult).toMatchObject({ key: "previous", runCutoffMs: Date.parse(later) });
    expect(checkPreviousKeyRunCutoff(midRun, secondResult.runCutoffMs)).toBe("fail");
    expect(checkPreviousKeyRunCutoff(midRun, strangerResult.runCutoffMs)).toBe("pass");
  });

  it("applies the entry run cutoff to a previous public key match", async () => {
    const { verifyDeploymentIdHeader, checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([
        { publicKey: first.publicKey },
        { publicKey: second.publicKey, runCutoff: CUTOFF_ISO },
      ]),
    });
    const token = await mintWorkloadDeploymentTokenEd25519(claims, second.privateKey, EXP);

    const result = await verifyDeploymentIdHeader(token, "http");

    expect(result).toMatchObject({ outcome: "jwt_valid", key: "previous" });
    if (result.outcome !== "jwt_valid") return;
    expect(
      checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2026, 4, 31)), result.runCutoffMs)
    ).toBe("pass");
    expect(
      checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2026, 9, 1)), result.runCutoffMs)
    ).toBe("fail");
  });

  it("throws at mint time when neither a signing key nor a secret is set", async () => {
    const { mintDeploymentToken } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET: "",
      TRIGGER_DEQUEUE_ENABLED: "false",
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([{ publicKey: first.publicKey }]),
    });

    await expect(mintDeploymentToken(claims)).rejects.toThrow(/WORKLOAD_TOKEN_SIGNING_KEY/);
  });

  it("prefers the signing key over the secret when minting", async () => {
    const { mintDeploymentToken } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SIGNING_KEY: first.privateKey,
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([{ publicKey: first.publicKey }]),
    });

    expect(await mintDeploymentToken(claims)).toBe(
      await mintWorkloadDeploymentTokenEd25519(claims, first.privateKey, EXP)
    );
  });

  it("rejects a token signed by a different ed25519 key", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([{ publicKey: first.publicKey }]),
    });
    const token = await mintWorkloadDeploymentTokenEd25519(claims, stranger.privateKey, EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toEqual({ outcome: "jwt_invalid" });
  });

  it("rejects an HS256 token signed with the public key PEM as the secret", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([{ publicKey: first.publicKey }]),
      WORKLOAD_TOKEN_SECRET: "unrelated-secret",
    });
    const token = await mintWorkloadDeploymentToken(claims, first.publicKey, EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toEqual({ outcome: "jwt_invalid" });
  });

  it("keeps the active secret current and the previous secret previous when public keys are set", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([{ publicKey: first.publicKey }]),
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });

    const bySecret = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
    const byPreviousSecret = await mintWorkloadDeploymentToken(claims, PREVIOUS_SECRET, EXP);

    expect(await verifyDeploymentIdHeader(bySecret, "http")).toMatchObject({
      outcome: "jwt_valid",
      key: "current",
    });
    expect(await verifyDeploymentIdHeader(byPreviousSecret, "http")).toMatchObject({
      outcome: "jwt_valid",
      key: "previous",
    });
  });

  it("verifies with public keys alone when no secret is configured", async () => {
    const { verifyDeploymentIdHeader } = await loadWorkloadToken({
      WORKLOAD_TOKEN_SECRET: "",
      TRIGGER_DEQUEUE_ENABLED: "false",
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([{ publicKey: first.publicKey }]),
    });
    const token = await mintWorkloadDeploymentTokenEd25519(claims, first.privateKey, EXP);

    expect(await verifyDeploymentIdHeader(token, "http")).toMatchObject({
      outcome: "jwt_valid",
      key: "current",
    });
  });

  it("gates the previous secret by the global cutoff, not an entry cutoff", async () => {
    const { verifyDeploymentIdHeader, checkPreviousKeyRunCutoff } = await loadWorkloadToken({
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysEnv([{ publicKey: first.publicKey }]),
      WORKLOAD_TOKEN_SECRET_PREVIOUS: PREVIOUS_SECRET,
      WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: CUTOFF_ISO,
    });

    expect(
      await verifyDeploymentIdHeader(await mintWorkloadDeploymentToken(claims, SECRET, EXP), "http")
    ).toMatchObject({ outcome: "jwt_valid", key: "current" });

    const previous = await verifyDeploymentIdHeader(
      await mintWorkloadDeploymentToken(claims, PREVIOUS_SECRET, EXP),
      "http"
    );
    expect(previous).toMatchObject({
      outcome: "jwt_valid",
      key: "previous",
      runCutoffMs: CUTOFF_MS,
    });
    if (previous.outcome !== "jwt_valid") return;
    expect(
      checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2026, 4, 31)), previous.runCutoffMs)
    ).toBe("pass");
    expect(
      checkPreviousKeyRunCutoff(runIdCreatedAt(Date.UTC(2026, 9, 1)), previous.runCutoffMs)
    ).toBe("fail");
  });
});
