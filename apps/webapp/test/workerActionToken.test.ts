import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { JWT_AUDIENCE, JWT_ISSUER } from "@trigger.dev/core/v3";
import { generateRunOpsId, generateRunOpsIdV2 } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkerActionTokenVerifier,
  evaluateWorkerActionToken,
  parseWorkerActionTokenConfig,
  parseWorkerActionTokenModes,
  type VerifiedWorkerActionToken,
  type WorkerActionTokenRuleInput,
} from "~/v3/services/worker/workerActionTokenVerifier.server";

const NOW_MS = Date.parse("2026-11-26T12:00:00.000Z");
const CUTOFF_MS = Date.parse("2026-11-01T00:00:00.000Z");
const ROUTE_RUN = "run_cmabc0000000000000000000";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    privateKey,
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function b64(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    ver: 1,
    deployment: "deployment_abc",
    deployment_version: "20261126.1",
    environment_id: "env_claim",
    environment_type: "PRODUCTION",
    org_id: "org_1",
    project_id: "proj_1",
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: Math.floor(NOW_MS / 1000) + 3600,
    ...overrides,
  };
}

function mintEd25519(privateKey: KeyObject, claims: Record<string, unknown> = payload()) {
  const signingInput = `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64(claims)}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

describe("worker action token verifier", () => {
  const primary = keyPair();

  it("accepts a valid Ed25519 token", () => {
    const verifier = createWorkerActionTokenVerifier([{ publicKey: primary.pem }], {
      now: () => NOW_MS,
    });
    const verified = verifier.verify(mintEd25519(primary.privateKey));
    expect(verified?.claims.environment_id).toBe("env_claim");
    expect(verified?.runCutoffMs).toBeUndefined();
  });

  it("rejects a token signed by another key", () => {
    const other = keyPair();
    const verifier = createWorkerActionTokenVerifier([{ publicKey: primary.pem }], {
      now: () => NOW_MS,
    });
    expect(verifier.verify(mintEd25519(other.privateKey))).toBeUndefined();
  });

  it("rejects an expired token", () => {
    const verifier = createWorkerActionTokenVerifier([{ publicKey: primary.pem }], {
      now: () => NOW_MS,
    });
    const token = mintEd25519(primary.privateKey, payload({ exp: Math.floor(NOW_MS / 1000) - 1 }));
    expect(verifier.verify(token)).toBeUndefined();
  });

  it("rejects malformed tokens", () => {
    const verifier = createWorkerActionTokenVerifier([{ publicKey: primary.pem }], {
      now: () => NOW_MS,
    });
    expect(verifier.verify("not-a-jwt")).toBeUndefined();
    expect(verifier.verify("a.b.c")).toBeUndefined();
    expect(verifier.verify("")).toBeUndefined();
    const valid = mintEd25519(primary.privateKey, payload({ environment_id: undefined }));
    expect(verifier.verify(valid)).toBeUndefined();
  });

  it("rejects HS256 signed with the public key PEM as the secret", () => {
    const verifier = createWorkerActionTokenVerifier([{ publicKey: primary.pem }], {
      now: () => NOW_MS,
    });
    const signingInput = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload())}`;
    const signature = createHmac("sha256", primary.pem).update(signingInput).digest("base64url");
    expect(verifier.verify(`${signingInput}.${signature}`)).toBeUndefined();
  });

  it("rejects alg none", () => {
    const verifier = createWorkerActionTokenVerifier([{ publicKey: primary.pem }], {
      now: () => NOW_MS,
    });
    expect(
      verifier.verify(`${b64({ alg: "none", typ: "JWT" })}.${b64(payload())}.`)
    ).toBeUndefined();
  });

  it("rejects a cached token once it has expired", () => {
    let now = NOW_MS;
    const verifier = createWorkerActionTokenVerifier([{ publicKey: primary.pem }], {
      now: () => now,
    });
    const token = mintEd25519(primary.privateKey, payload({ exp: Math.floor(NOW_MS / 1000) + 10 }));
    expect(verifier.verify(token)).toBeDefined();
    expect(verifier.verify(token)).toBeDefined();
    now = NOW_MS + 11_000;
    expect(verifier.verify(token)).toBeUndefined();
  });

  it("reports the run cutoff of a previous key", () => {
    const previous = keyPair();
    const verifier = createWorkerActionTokenVerifier(
      [{ publicKey: primary.pem }, { publicKey: previous.pem, runCutoff: "2026-11-01T00:00:00Z" }],
      { now: () => NOW_MS }
    );
    expect(verifier.verify(mintEd25519(previous.privateKey))?.runCutoffMs).toBe(CUTOFF_MS);
  });
});

describe("worker action token config", () => {
  const primary = keyPair();
  const keysJson = JSON.stringify([{ publicKey: primary.pem }]);

  it("defaults every action to off when unset", () => {
    const modes = parseWorkerActionTokenModes(undefined);
    expect(Object.values(modes).every((mode) => mode === "off")).toBe(true);
  });

  it("rejects an empty default", () => {
    expect(() => parseWorkerActionTokenModes("default=")).toThrow();
  });

  it("applies a per-action override on top of the default", () => {
    const modes = parseWorkerActionTokenModes("default=log,heartbeat=off,start_version=enforce");
    expect(modes.start).toBe("log");
    expect(modes.heartbeat).toBe("off");
    expect(modes["start_version"]).toBe("enforce");
  });

  it("rejects an unknown action", () => {
    expect(() => parseWorkerActionTokenModes("dequeue=log")).toThrow();
  });

  it("rejects an unknown mode", () => {
    expect(() => parseWorkerActionTokenModes("start=strict")).toThrow();
  });

  it("rejects enforce without public keys", () => {
    expect(() =>
      parseWorkerActionTokenConfig({
        modes: "start=enforce",
        publicKeys: undefined,
        cutoff: "2026-11-01T00:00:00Z",
      })
    ).toThrow();
  });

  it("rejects enforce without a cutoff", () => {
    expect(() =>
      parseWorkerActionTokenConfig({
        modes: "start=enforce",
        publicKeys: keysJson,
        cutoff: undefined,
      })
    ).toThrow();
  });

  it("accepts enforce with keys and a cutoff", () => {
    const config = parseWorkerActionTokenConfig({
      modes: "default=enforce",
      publicKeys: keysJson,
      cutoff: "2026-11-01T00:00:00Z",
    });
    expect(config.cutoffMs).toBe(CUTOFF_MS);
    expect(config.publicKeys).toHaveLength(1);
  });

  it("rejects a non-Ed25519 public key", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() =>
      parseWorkerActionTokenConfig({
        modes: undefined,
        publicKeys: JSON.stringify([{ publicKey: pem }]),
        cutoff: undefined,
      })
    ).toThrow();
  });
});

function verifiedToken(
  overrides: Partial<VerifiedWorkerActionToken["claims"]> = {},
  runCutoffMs?: number
): VerifiedWorkerActionToken {
  return {
    claims: {
      ver: 1,
      deployment: "deployment_abc",
      deployment_version: "20261126.1",
      environment_id: "env_claim",
      environment_type: "PRODUCTION",
      org_id: "org_1",
      project_id: "proj_1",
      exp: Math.floor(NOW_MS / 1000) + 3600,
      ...overrides,
    },
    runCutoffMs,
  };
}

function ruleInput(
  overrides: Partial<WorkerActionTokenRuleInput> = {}
): WorkerActionTokenRuleInput {
  return {
    mode: "enforce",
    routeRunFriendlyId: ROUTE_RUN,
    tokenKind: "child",
    cutoffMs: CUTOFF_MS,
    loadRunCreatedAt: async () => new Date(CUTOFF_MS + 60_000),
    ...overrides,
  };
}

describe("worker action token rule", () => {
  it("allows a verified token without reading the run", async () => {
    let reads = 0;
    const result = await evaluateWorkerActionToken(
      ruleInput({
        token: verifiedToken(),
        loadRunCreatedAt: async () => {
          reads++;
          return undefined;
        },
      })
    );
    expect(result).toMatchObject({ outcome: "verified", allowed: true });
    expect(reads).toBe(0);
  });

  it("denies a token for another run", async () => {
    const result = await evaluateWorkerActionToken(
      ruleInput({ token: verifiedToken({ run: "run_other" }) })
    );
    expect(result).toMatchObject({ outcome: "run_mismatch", allowed: false });
  });

  it("reports an environment mismatch in log mode", async () => {
    const result = await evaluateWorkerActionToken(
      ruleInput({ mode: "log", token: verifiedToken(), headerEnvironmentId: "env_header" })
    );
    expect(result).toMatchObject({ outcome: "env_mismatch", allowed: true });
  });

  it("exempts the global worker token", async () => {
    const result = await evaluateWorkerActionToken(ruleInput({ tokenKind: "global" }));
    expect(result).toMatchObject({ outcome: "global_exempt", allowed: true });
  });

  it("does not exempt the previous global worker token", async () => {
    const result = await evaluateWorkerActionToken(ruleInput({ tokenKind: "previous-global" }));
    expect(result).toMatchObject({ outcome: "denied", allowed: false, createdAfterCutoff: "true" });
  });

  it("grandfathers a run created before the cutoff", async () => {
    const result = await evaluateWorkerActionToken(
      ruleInput({ loadRunCreatedAt: async () => new Date(CUTOFF_MS - 60_000) })
    );
    expect(result).toMatchObject({
      outcome: "grandfathered",
      allowed: true,
      createdAfterCutoff: "false",
    });
  });

  it("denies a run created after the cutoff", async () => {
    const result = await evaluateWorkerActionToken(ruleInput());
    expect(result).toMatchObject({ outcome: "denied", allowed: false, createdAfterCutoff: "true" });
  });

  it("denies a run that does not exist", async () => {
    const result = await evaluateWorkerActionToken(
      ruleInput({ loadRunCreatedAt: async () => undefined })
    );
    expect(result).toMatchObject({ outcome: "denied", allowed: false });
  });

  it("denies a foreign-prefix id created after the cutoff", async () => {
    const result = await evaluateWorkerActionToken(
      ruleInput({ routeRunFriendlyId: "x_cmabc0000000000000000000" })
    );
    expect(result).toMatchObject({ outcome: "denied", allowed: false });
  });

  it("denies a cuid run created after the cutoff", async () => {
    const result = await evaluateWorkerActionToken(
      ruleInput({ routeRunFriendlyId: "run_clabcdefghijklmnopqrstuvw" })
    );
    expect(result).toMatchObject({ outcome: "denied", allowed: false });
  });

  it("drops a previous-key token for a run created after its cutoff", async () => {
    const result = await evaluateWorkerActionToken(
      ruleInput({
        routeRunFriendlyId: "x_cmabc0000000000000000000",
        token: verifiedToken({}, CUTOFF_MS),
      })
    );
    expect(result).toMatchObject({ outcome: "denied", allowed: false });
  });

  it("accepts a previous-key token for a run created before its cutoff", async () => {
    const result = await evaluateWorkerActionToken(
      ruleInput({
        routeRunFriendlyId: "x_cmabc0000000000000000000",
        token: verifiedToken({}, CUTOFF_MS),
        loadRunCreatedAt: async () => new Date(CUTOFF_MS - 60_000),
      })
    );
    expect(result).toMatchObject({ outcome: "verified", allowed: true });
  });
});

function mintAt(atMs: number, mint: () => string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(atMs);
  try {
    return mint();
  } finally {
    vi.useRealTimers();
  }
}

function countingRead(createdAt: Date | undefined) {
  const counter = { reads: 0 };
  return {
    counter,
    loadRunCreatedAt: async () => {
      counter.reads++;
      return createdAt;
    },
  };
}

const RUN_OPS_ID_VERSIONS = [
  ["v1", () => generateRunOpsId()],
  ["v2", () => generateRunOpsIdV2("a")],
] as const;

describe("worker action token rule, run creation time", () => {
  describe.each(RUN_OPS_ID_VERSIONS)("run-ops %s id", (_version, mint) => {
    it("denies a run minted after the cutoff without a row read", async () => {
      const body = mintAt(CUTOFF_MS + 60_000, mint);
      const read = countingRead(new Date(CUTOFF_MS - 60_000));
      const result = await evaluateWorkerActionToken(
        ruleInput({ routeRunFriendlyId: `run_${body}`, loadRunCreatedAt: read.loadRunCreatedAt })
      );
      expect(result).toMatchObject({
        outcome: "denied",
        allowed: false,
        createdAfterCutoff: "true",
      });
      expect(read.counter.reads).toBe(0);
    });

    it("grandfathers a run minted at the cutoff without a row read", async () => {
      const body = mintAt(CUTOFF_MS, mint);
      const read = countingRead(new Date(CUTOFF_MS + 60_000));
      const result = await evaluateWorkerActionToken(
        ruleInput({ routeRunFriendlyId: `run_${body}`, loadRunCreatedAt: read.loadRunCreatedAt })
      );
      expect(result).toMatchObject({ outcome: "grandfathered", allowed: true });
      expect(read.counter.reads).toBe(0);
    });

    it("grandfathers a run minted before the cutoff without a row read", async () => {
      const body = mintAt(CUTOFF_MS - 60_000, mint);
      const read = countingRead(new Date(CUTOFF_MS + 60_000));
      const result = await evaluateWorkerActionToken(
        ruleInput({ routeRunFriendlyId: `run_${body}`, loadRunCreatedAt: read.loadRunCreatedAt })
      );
      expect(result).toMatchObject({ outcome: "grandfathered", allowed: true });
      expect(read.counter.reads).toBe(0);
    });

    it("decides a foreign prefix on the same body by the row read", async () => {
      const body = mintAt(CUTOFF_MS - 60_000, mint);
      const read = countingRead(new Date(CUTOFF_MS + 60_000));
      const result = await evaluateWorkerActionToken(
        ruleInput({ routeRunFriendlyId: `x_${body}`, loadRunCreatedAt: read.loadRunCreatedAt })
      );
      expect(result).toMatchObject({
        outcome: "denied",
        allowed: false,
        createdAfterCutoff: "true",
      });
      expect(read.counter.reads).toBe(1);
    });
  });

  it("denies a cuid run created after the cutoff by the row read", async () => {
    const read = countingRead(new Date(CUTOFF_MS + 60_000));
    const result = await evaluateWorkerActionToken(
      ruleInput({
        routeRunFriendlyId: "run_clabcdefghijklmnopqrstuvw",
        loadRunCreatedAt: read.loadRunCreatedAt,
      })
    );
    expect(result).toMatchObject({ outcome: "denied", allowed: false });
    expect(read.counter.reads).toBe(1);
  });

  it("grandfathers a cuid run created before the cutoff by the row read", async () => {
    const read = countingRead(new Date(CUTOFF_MS - 60_000));
    const result = await evaluateWorkerActionToken(
      ruleInput({
        routeRunFriendlyId: "run_clabcdefghijklmnopqrstuvw",
        loadRunCreatedAt: read.loadRunCreatedAt,
      })
    );
    expect(result).toMatchObject({ outcome: "grandfathered", allowed: true });
    expect(read.counter.reads).toBe(1);
  });

  it("checks a previous-key token against the run id without a row read", async () => {
    const body = mintAt(CUTOFF_MS + 60_000, generateRunOpsId);
    const read = countingRead(new Date(CUTOFF_MS - 60_000));
    const result = await evaluateWorkerActionToken(
      ruleInput({
        routeRunFriendlyId: `run_${body}`,
        token: verifiedToken({}, CUTOFF_MS),
        loadRunCreatedAt: read.loadRunCreatedAt,
      })
    );
    expect(result).toMatchObject({ outcome: "denied", allowed: false });
    expect(read.counter.reads).toBe(0);
  });
});
