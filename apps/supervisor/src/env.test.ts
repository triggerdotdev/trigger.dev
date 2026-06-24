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

describe("Env superRefine - backpressure source awareness", () => {
  it("accepts k8s-pod-count source without a Redis host", () => {
    expect(() =>
      Env.parse({
        ...base,
        TRIGGER_DEQUEUE_BACKPRESSURE_ENABLED: "true",
        TRIGGER_DEQUEUE_BACKPRESSURE_SOURCE: "k8s-pod-count",
      })
    ).not.toThrow();
  });

  it("rejects redis source when Redis host is absent", () => {
    expect(() =>
      Env.parse({
        ...base,
        TRIGGER_DEQUEUE_BACKPRESSURE_ENABLED: "true",
        TRIGGER_DEQUEUE_BACKPRESSURE_SOURCE: "redis",
      })
    ).toThrow();
  });
});
