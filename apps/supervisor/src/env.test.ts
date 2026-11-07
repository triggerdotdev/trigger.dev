import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, vi } from "vitest";

// Mock std-env before importing env.ts so the module-level `Env.parse(stdEnv)`
// doesn't fail in a test environment that lacks required vars.
vi.mock("std-env", () => ({
  env: {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  },
}));

const { Env } = await import("./env.js");

// Minimal env that satisfies all required fields; everything else has defaults.
const base = {
  TRIGGER_API_URL: "http://localhost:3030",
  TRIGGER_WORKER_TOKEN: "test-token",
  MANAGED_WORKER_SECRET: "test-secret",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
};

describe("worker queue selection", () => {
  const ondemand = {
    class: "ondemand",
    phase: "fresh",
    compat: "container",
    channel: "stable",
  };
  const restore = {
    class: "ondemand",
    phase: "restore",
    compat: "container",
    channel: "canary",
  };

  it("keeps legacy default and scheduled selection when subscriptions are absent", () => {
    expect(Env.parse(base).TRIGGER_WORKER_QUEUE_CLASS).toBe("default");
    expect(
      Env.parse({ ...base, TRIGGER_WORKER_QUEUE_CLASS: "scheduled" }).TRIGGER_WORKER_QUEUE_CLASS
    ).toBe("scheduled");
  });

  it("parses multiple subscriptions without adding a legacy queue class", () => {
    const subscriptions = [{ ...ondemand, weight: 0.25 }, restore];
    const parsed = Env.parse({
      ...base,
      TRIGGER_CHECKPOINT_URL: "http://localhost:8089",
      TRIGGER_WORKER_QUEUE_SUBSCRIPTIONS: JSON.stringify(subscriptions),
    });
    expect(parsed.TRIGGER_WORKER_QUEUE_SUBSCRIPTIONS).toEqual(subscriptions);
    expect(parsed.TRIGGER_WORKER_QUEUE_CLASS).toBeUndefined();
  });

  it.each(["default", "scheduled"])(
    "rejects subscriptions with explicit %s selection",
    (queueClass) => {
      expect(() =>
        Env.parse({
          ...base,
          TRIGGER_WORKER_QUEUE_CLASS: queueClass,
          TRIGGER_WORKER_QUEUE_SUBSCRIPTIONS: JSON.stringify([ondemand]),
        })
      ).toThrow("mutually exclusive");
    }
  );

  it.each(["not-json", "[]", JSON.stringify([{ ...restore, phase: "unknown" }])])(
    "rejects invalid subscriptions: %s",
    (subscriptions) => {
      expect(() =>
        Env.parse({ ...base, TRIGGER_WORKER_QUEUE_SUBSCRIPTIONS: subscriptions })
      ).toThrow();
    }
  );

  it.each([
    { config: {}, subscription: { ...ondemand, compat: "compute" }, error: "compatibility" },
    {
      config: {
        KUBERNETES_FORCE_ENABLED: "true",
        KUBERNETES_RUN_CRD_ENABLED: "true",
        KUBERNETES_RUNNER_RUNTIME: "microvm",
      },
      subscription: ondemand,
      error: "compatibility",
    },
    { config: {}, subscription: restore, error: "TRIGGER_CHECKPOINT_URL" },
    {
      config: {
        KUBERNETES_FORCE_ENABLED: "true",
        KUBERNETES_RUN_CRD_ENABLED: "false",
        KUBERNETES_RUNNER_RUNTIME: "microvm",
      },
      subscription: { ...restore, compat: "compute" },
      error: "compatibility",
    },
  ])(
    "rejects incompatible or unsupported subscriptions: $error",
    ({ config, subscription, error }) => {
      expect(() =>
        Env.parse({
          ...base,
          ...config,
          TRIGGER_WORKER_QUEUE_SUBSCRIPTIONS: JSON.stringify([subscription]),
        })
      ).toThrow(error);
    }
  );

  it.each(["ondemand", "scheduled"])(
    "accepts %s compute restores on the native microVM Runner backend",
    (queueClass) => {
      expect(() =>
        Env.parse({
          ...base,
          KUBERNETES_FORCE_ENABLED: "true",
          KUBERNETES_RUN_CRD_ENABLED: "true",
          KUBERNETES_RUNNER_RUNTIME: "microvm",
          TRIGGER_WORKER_QUEUE_SUBSCRIPTIONS: JSON.stringify([
            { ...ondemand, class: queueClass, compat: "compute" },
            { ...restore, class: queueClass, compat: "compute" },
          ]),
        })
      ).not.toThrow();
    }
  );

  it("accepts shared fresh work and compute restores on the native microVM Runner backend", () => {
    expect(() =>
      Env.parse({
        ...base,
        KUBERNETES_FORCE_ENABLED: "true",
        KUBERNETES_RUN_CRD_ENABLED: "true",
        KUBERNETES_RUNNER_RUNTIME: "microvm",
        TRIGGER_WORKER_QUEUE_SUBSCRIPTIONS: JSON.stringify([
          { ...ondemand, compat: "any" },
          { ...restore, compat: "compute" },
        ]),
      })
    ).not.toThrow();
  });
});

describe("Env superRefine - backpressure source awareness", () => {
  it("pod-count source can be enabled without a Redis host", () => {
    expect(() =>
      Env.parse({
        ...base,
        TRIGGER_DEQUEUE_BACKPRESSURE_POD_COUNT_ENABLED: "true",
      })
    ).not.toThrow();
  });

  it("redis source requires a Redis host", () => {
    expect(() =>
      Env.parse({
        ...base,
        TRIGGER_DEQUEUE_BACKPRESSURE_ENABLED: "true",
      })
    ).toThrow();
  });

  it("both sources can be enabled together (with a Redis host)", () => {
    expect(() =>
      Env.parse({
        ...base,
        TRIGGER_DEQUEUE_BACKPRESSURE_ENABLED: "true",
        TRIGGER_DEQUEUE_BACKPRESSURE_REDIS_HOST: "localhost",
        TRIGGER_DEQUEUE_BACKPRESSURE_POD_COUNT_ENABLED: "true",
      })
    ).not.toThrow();
  });

  it("rejects pod-count release >= engage when the source is enabled", () => {
    expect(() =>
      Env.parse({
        ...base,
        TRIGGER_DEQUEUE_BACKPRESSURE_POD_COUNT_ENABLED: "true",
        TRIGGER_DEQUEUE_BACKPRESSURE_POD_COUNT_ENGAGE: "100",
        TRIGGER_DEQUEUE_BACKPRESSURE_POD_COUNT_RELEASE: "100",
      })
    ).toThrow();
  });
});

describe("releasing runs that never started", () => {
  it("is off by default for both failed creates and failed pods", () => {
    const env = Env.parse(base);
    expect(env.RELEASE_UNSTARTED_RUNS_ENABLED).toBe(false);
    expect(env.RELEASE_FAILED_POD_RUNS_ENABLED).toBe(false);
  });

  it("limits releases to five different runs a minute unless told otherwise, never fewer than none", () => {
    expect(Env.parse(base).RUN_RELEASES_PER_MINUTE).toBe(5);
    expect(Env.parse({ ...base, RUN_RELEASES_PER_MINUTE: "0" }).RUN_RELEASES_PER_MINUTE).toBe(0);
    expect(() => Env.parse({ ...base, RUN_RELEASES_PER_MINUTE: "-1" })).toThrow();
    expect(Env.parse({ ...base, RUN_RELEASES_PER_MINUTE: " " }).RUN_RELEASES_PER_MINUTE).toBe(5);
  });

  it("turns on each path on its own", () => {
    const creates = Env.parse({ ...base, RELEASE_UNSTARTED_RUNS_ENABLED: "true" });
    expect(creates.RELEASE_UNSTARTED_RUNS_ENABLED).toBe(true);
    expect(creates.RELEASE_FAILED_POD_RUNS_ENABLED).toBe(false);

    const pods = Env.parse({ ...base, RELEASE_FAILED_POD_RUNS_ENABLED: "1" });
    expect(pods.RELEASE_UNSTARTED_RUNS_ENABLED).toBe(false);
    expect(pods.RELEASE_FAILED_POD_RUNS_ENABLED).toBe(true);
  });
});

describe("worker cell name", () => {
  it("treats an empty value as unset", () => {
    expect(
      Env.parse({ ...base, TRIGGER_WORKER_CELL_NAME: "" }).TRIGGER_WORKER_CELL_NAME
    ).toBeUndefined();
  });

  it("keeps a well-formed name", () => {
    expect(
      Env.parse({ ...base, TRIGGER_WORKER_CELL_NAME: "us-west-2.cell_1" }).TRIGGER_WORKER_CELL_NAME
    ).toBe("us-west-2.cell_1");
  });

  it("refuses a malformed name at boot", () => {
    expect(() => Env.parse({ ...base, TRIGGER_WORKER_CELL_NAME: "bad/name" })).toThrow();
  });
});

describe("continue retry budget", () => {
  it("is off when unset", () => {
    expect(Env.parse(base).TRIGGER_CONTINUE_RETRY_BUDGET_MS).toBeUndefined();
  });

  it("accepts a budget within the bounds", () => {
    for (const value of ["120000", "270000", "290000"]) {
      expect(
        Env.parse({ ...base, TRIGGER_CONTINUE_RETRY_BUDGET_MS: value })
          .TRIGGER_CONTINUE_RETRY_BUDGET_MS
      ).toBe(Number(value));
    }
  });

  it.each(["", "0", "-1", "60000", "119999", "290001", "not-a-number"])(
    "refuses %j, so a bad value stops the supervisor from starting",
    (value) => {
      expect(() => Env.parse({ ...base, TRIGGER_CONTINUE_RETRY_BUDGET_MS: value })).toThrow();
    }
  );
});

describe("runner token Secret settle delay", () => {
  it("defaults to two minutes", () => {
    expect(Env.parse(base).KUBERNETES_RUNNER_TOKEN_SECRET_SETTLE_MS).toBe(120_000);
  });

  it("takes a number of milliseconds from a minute up and refuses less", () => {
    expect(
      Env.parse({ ...base, KUBERNETES_RUNNER_TOKEN_SECRET_SETTLE_MS: "60000" })
        .KUBERNETES_RUNNER_TOKEN_SECRET_SETTLE_MS
    ).toBe(60_000);
    expect(
      Env.safeParse({ ...base, KUBERNETES_RUNNER_TOKEN_SECRET_SETTLE_MS: "59999" }).success
    ).toBe(false);
  });
});

describe("previous workload token key", () => {
  it("defaults the cutoff mode to log", () => {
    expect(Env.parse(base).WORKLOAD_TOKEN_PREVIOUS_CUTOFF_MODE).toBe("log");
  });

  it("refuses a run cutoff without a previous secret", () => {
    const cutoff = { WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z" };
    expect(Env.safeParse({ ...base, ...cutoff }).success).toBe(false);
    expect(
      Env.safeParse({ ...base, ...cutoff, WORKLOAD_TOKEN_SECRET_PREVIOUS: "previous" }).success
    ).toBe(true);
  });

  it("refuses a run cutoff with public keys and the active secret, since neither is previous", () => {
    const cutoff = { WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z" };
    const publicKeys = { WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysJson([ed25519Pems.publicKey]) };
    expect(Env.safeParse({ ...base, ...cutoff, ...publicKeys }).success).toBe(false);
    expect(
      Env.safeParse({ ...base, ...cutoff, ...publicKeys, WORKLOAD_TOKEN_SECRET: "secret" }).success
    ).toBe(false);
    expect(
      Env.safeParse({
        ...base,
        ...cutoff,
        ...publicKeys,
        WORKLOAD_TOKEN_SECRET: "secret",
        WORKLOAD_TOKEN_SECRET_PREVIOUS: "previous",
      }).success
    ).toBe(true);
  });

  it("does not let a second public key satisfy the global run cutoff", () => {
    const cutoff = { WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z" };
    const twoKeys = publicKeysJson([
      { publicKey: ed25519Pems.publicKey },
      { publicKey: ed25519PemsSecond.publicKey, runCutoff: "2026-06-01T00:00:00.000Z" },
    ]);
    expect(Env.safeParse({ ...base, ...cutoff, WORKLOAD_TOKEN_PUBLIC_KEYS: twoKeys }).success).toBe(
      false
    );
  });

  it("accepts a run cutoff with the previous secret alongside public keys", () => {
    const cutoff = { WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z" };
    expect(
      Env.safeParse({
        ...base,
        ...cutoff,
        WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysJson([ed25519Pems.publicKey]),
        WORKLOAD_TOKEN_SECRET_PREVIOUS: "previous",
      }).success
    ).toBe(true);
  });
});

function publicKeysJson(entries: (string | { publicKey: string; runCutoff?: string })[]) {
  return JSON.stringify(
    entries.map((entry) => (typeof entry === "string" ? { publicKey: entry } : entry))
  );
}

function generateEd25519Pems() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const ed25519Pems = generateEd25519Pems();
const ed25519PemsSecond = generateEd25519Pems();

describe("ed25519 workload token keys", () => {
  it("needs a secret or a public key without runCutoff once enforcement is on", () => {
    const enforced = { ...base, WORKLOAD_TOKEN_ENFORCEMENT: "enforce" };
    expect(Env.safeParse(enforced).success).toBe(false);
    expect(Env.safeParse({ ...enforced, WORKLOAD_TOKEN_SECRET: "secret" }).success).toBe(true);
    expect(
      Env.safeParse({
        ...enforced,
        WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysJson([ed25519Pems.publicKey]),
        TRIGGER_DEQUEUE_ENABLED: "false",
      }).success
    ).toBe(true);
  });

  it("refuses enforcement when every public key entry has a runCutoff and there is no secret", () => {
    const enforced = {
      ...base,
      WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
      TRIGGER_DEQUEUE_ENABLED: "false",
    };
    const allCut = publicKeysJson([
      { publicKey: ed25519Pems.publicKey, runCutoff: "2026-06-01T00:00:00.000Z" },
    ]);
    expect(Env.safeParse({ ...enforced, WORKLOAD_TOKEN_PUBLIC_KEYS: allCut }).success).toBe(false);
    expect(
      Env.safeParse({
        ...enforced,
        WORKLOAD_TOKEN_PUBLIC_KEYS: allCut,
        WORKLOAD_TOKEN_SECRET: "secret",
      }).success
    ).toBe(true);
  });

  it("accepts an entry with runCutoff alongside one without", () => {
    const mixed = publicKeysJson([
      { publicKey: ed25519Pems.publicKey },
      { publicKey: ed25519PemsSecond.publicKey, runCutoff: "2026-06-01T00:00:00.000Z" },
    ]);
    expect(
      Env.safeParse({
        ...base,
        WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
        TRIGGER_DEQUEUE_ENABLED: "false",
        WORKLOAD_TOKEN_PUBLIC_KEYS: mixed,
      }).success
    ).toBe(true);
  });

  it("refuses a public key entry with a bad runCutoff", () => {
    const bad = publicKeysJson([{ publicKey: ed25519Pems.publicKey, runCutoff: "tomorrow" }]);
    expect(Env.safeParse({ ...base, WORKLOAD_TOKEN_PUBLIC_KEYS: bad }).success).toBe(false);
  });

  it("refuses public keys alone while dequeuing, since every dequeued run needs a minted token", () => {
    const enforced = { ...base, WORKLOAD_TOKEN_ENFORCEMENT: "enforce" };
    const publicOnly = {
      ...enforced,
      WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysJson([ed25519Pems.publicKey]),
    };
    expect(Env.safeParse(publicOnly).success).toBe(false);
    expect(
      Env.safeParse({ ...publicOnly, WORKLOAD_TOKEN_SIGNING_KEY: ed25519Pems.privateKey }).success
    ).toBe(true);
    expect(Env.safeParse({ ...publicOnly, WORKLOAD_TOKEN_SECRET: "secret" }).success).toBe(true);
  });

  it("lets a pod without the workload API mint with only a signing key", () => {
    const mintOnly = {
      ...base,
      WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
      TRIGGER_WORKLOAD_API_ENABLED: "false",
      WORKLOAD_TOKEN_SIGNING_KEY: ed25519Pems.privateKey,
    };
    expect(Env.safeParse(mintOnly).success).toBe(true);
    expect(Env.safeParse({ ...mintOnly, TRIGGER_WORKLOAD_API_ENABLED: "true" }).success).toBe(
      false
    );
  });

  it("accepts an ed25519 signing key and refuses anything else", () => {
    expect(
      Env.safeParse({ ...base, WORKLOAD_TOKEN_SIGNING_KEY: ed25519Pems.privateKey }).success
    ).toBe(true);
    expect(Env.safeParse({ ...base, WORKLOAD_TOKEN_SIGNING_KEY: "not-a-key" }).success).toBe(false);
  });

  it("refuses public keys that are not a JSON array of ed25519 SPKI PEM entries", () => {
    expect(Env.safeParse({ ...base, WORKLOAD_TOKEN_PUBLIC_KEYS: "not-a-key" }).success).toBe(false);
    expect(
      Env.safeParse({ ...base, WORKLOAD_TOKEN_PUBLIC_KEYS: ed25519Pems.publicKey }).success
    ).toBe(false);
    expect(
      Env.safeParse({
        ...base,
        WORKLOAD_TOKEN_PUBLIC_KEYS: publicKeysJson([ed25519Pems.privateKey]),
      }).success
    ).toBe(false);
  });
});

describe("WORKLOAD_TOKEN_SECRETS", () => {
  const enforced = {
    ...base,
    WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
    TRIGGER_DEQUEUE_ENABLED: "false",
  };

  it("accepts a valid list and unset or blank values", () => {
    expect(
      Env.safeParse({
        ...base,
        WORKLOAD_TOKEN_SECRETS: "alpha, beta:2026-06-01T00:00:00.000Z",
      }).success
    ).toBe(true);
    expect(Env.safeParse({ ...base, WORKLOAD_TOKEN_SECRETS: "  " }).success).toBe(true);
  });

  it.each(["alpha:tomorrow", "alpha,,beta", ":2026-06-01T00:00:00.000Z"])(
    "refuses %j and names the variable",
    (value) => {
      const result = Env.safeParse({ ...base, WORKLOAD_TOKEN_SECRETS: value });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues.map((issue) => issue.message)).toContainEqual(
        expect.stringMatching(/^WORKLOAD_TOKEN_SECRETS/)
      );
    }
  );

  it("satisfies the enforcement requirement with an entry without a cutoff", () => {
    expect(Env.safeParse(enforced).success).toBe(false);
    expect(Env.safeParse({ ...enforced, WORKLOAD_TOKEN_SECRETS: "alpha" }).success).toBe(true);
  });

  it("does not satisfy the enforcement requirement with cut entries only", () => {
    expect(
      Env.safeParse({ ...enforced, WORKLOAD_TOKEN_SECRETS: "alpha:2026-06-01T00:00:00.000Z" })
        .success
    ).toBe(false);
  });
});

describe("guest snapshot cleaner", () => {
  // Catches: the cleaner turning on, or starting without a proxy or token, by default.
  it("is off by default and needs a node proxy URL and a token path when enabled", () => {
    expect(Env.parse(base).GUEST_SNAPSHOT_CLEANER_ENABLED).toBe(false);
    const enabled = { ...base, GUEST_SNAPSHOT_CLEANER_ENABLED: "true" };
    const proxy = { GUEST_SNAPSHOT_CLEANER_NODE_PROXY_URL: "http://10.0.0.1:8083" };
    const token = { GUEST_SNAPSHOT_CLEANER_TOKEN_PATH: "/var/run/secrets/cleaner/token" };
    expect(Env.safeParse({ ...enabled, ...proxy }).success).toBe(false);
    expect(Env.safeParse({ ...enabled, ...token }).success).toBe(false);
    expect(Env.safeParse({ ...enabled, ...proxy, ...token }).success).toBe(true);
  });
});
