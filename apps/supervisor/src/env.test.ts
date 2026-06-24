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
});
