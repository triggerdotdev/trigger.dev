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
