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
      config: { COMPUTE_GATEWAY_URL: "http://localhost:8080" },
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
    "accepts %s compute restores on the native microVM Runner backend without a gateway",
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

  it("accepts shared fresh work and compute restores on the compute backend", () => {
    expect(() =>
      Env.parse({
        ...base,
        COMPUTE_GATEWAY_URL: "http://localhost:8080",
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

describe("Env superRefine - compute snapshots", () => {
  it("needs the metadata URL and workload API domain only for the gateway", () => {
    expect(() => Env.parse({ ...base, COMPUTE_SNAPSHOTS_ENABLED: "true" })).not.toThrow();
    expect(() =>
      Env.parse({
        ...base,
        COMPUTE_SNAPSHOTS_ENABLED: "true",
        COMPUTE_GATEWAY_URL: "http://gateway:8080",
      })
    ).toThrow(/TRIGGER_METADATA_URL[\s\S]*TRIGGER_WORKLOAD_API_DOMAIN/);
  });
});
