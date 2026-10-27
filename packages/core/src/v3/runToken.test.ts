import { metrics } from "@opentelemetry/api";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { afterEach, describe, expect, it } from "vitest";
import { isRunToken, resolveRunTokenCredential } from "./runToken.js";
import { runTokenOperationPolicy } from "./runTokenOperations.js";
import { sdkCredentialTelemetryOperations } from "./sdkCredentialTelemetry.js";
import { sdkScope } from "./sdkScope/index.js";
import "./sdkScope/storage-node.js";
import { runInMockTaskContext } from "./test/mock-task-context.js";

const FALLBACK = "tr_dev_compatibility_key";
const originalRunToken = process.env.TRIGGER_RUN_TOKEN;

function runToken(
  overrides: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: "RS256", typ: "run+jwt" }
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode(header),
    encode({
      token_use: "run",
      aud: "trigger:api",
      exp: Math.floor(Date.now() / 1_000) + 3600,
      scopes: ["admin"],
      ...overrides,
    }),
    // Deliberately not signed: only the server verifies authenticity.
    encode("unverified-signature"),
  ].join(".");
}

afterEach(() => {
  if (originalRunToken === undefined) delete process.env.TRIGGER_RUN_TOKEN;
  else process.env.TRIGGER_RUN_TOKEN = originalRunToken;
});

describe("isRunToken", () => {
  it("classifies the header without verifying signature, claims, expiry or scope", () => {
    expect(isRunToken(runToken({ exp: 1, scopes: ["read:runs"] }))).toBe(true);
    expect(isRunToken(runToken({ token_use: "other" }))).toBe(true);
    expect(isRunToken(runToken({}, { alg: "RS256", typ: "JWT" }))).toBe(false);
    for (const token of [
      FALLBACK,
      "",
      "bad.bad.bad",
      `${runToken()}.extra`,
      "..",
      runToken() + "=",
    ]) {
      expect(isRunToken(token)).toBe(false);
    }
  });
});

describe("resolveRunTokenCredential", () => {
  it("has a server telemetry label for every credential routing operation", () => {
    expect(sdkCredentialTelemetryOperations).toEqual(
      expect.arrayContaining(Object.keys(runTokenOperationPolicy))
    );
  });

  it("leaves fallback unchanged outside a task, including an isolated SDK scope", async () => {
    process.env.TRIGGER_RUN_TOKEN = runToken();
    expect(resolveRunTokenCredential("retrieveRun", FALLBACK)).toBe(FALLBACK);
    expect(resolveRunTokenCredential("retrieveRun", undefined)).toBeUndefined();

    await runInMockTaskContext(() => {
      sdkScope.withScope({ apiClientConfig: {}, inheritContext: false }, () => {
        expect(resolveRunTokenCredential("retrieveRun", FALLBACK)).toBe(FALLBACK);
      });
    });
  });

  it("selects current admin token for runtime and covered management operations without needing a key", async () => {
    const token = runToken();
    process.env.TRIGGER_RUN_TOKEN = token;
    await runInMockTaskContext(() => {
      for (const operation of [
        "triggerTask",
        "createUploadPayloadUrl",
        "getRunMetadata",
        "waitForWaitpointToken",
        "createPublicToken",
        "fetchStream",
        "createStream",
        "appendToStream",
        "sendInputStream",
        "createInputStreamWaitpoint",
        "legacyStreamIngest",
        "legacyStreamResumeProbe",
        "createSession",
        "subscribeToSessionStream",
        "createSessionStreamWaitpoint",
        "resolvePrompt",
        "cancelWebhookWaiter",
        "listRuns",
        "pauseQueue",
        "listDeployments",
        "executeQuery",
        "createPromptOverride",
      ]) {
        expect(resolveRunTokenCredential(operation, FALLBACK), operation).toBe(token);
        expect(resolveRunTokenCredential(operation, undefined), operation).toBe(token);
      }
    });
  });

  it("keeps compatibility credentials for unsupported, default, unknown and inherited property names", async () => {
    process.env.TRIGGER_RUN_TOKEN = runToken();
    await runInMockTaskContext(() => {
      for (const operation of [
        "getRunResult",
        "getBatchResults",
        "rescheduleRun",
        "listSchedules",
        "createSchedule",
        "listEnvVars",
        "importEnvVars",
        "generateJWTClaims",
        "listProjectRuns",
        "executeQueryProjectOrOrganization",
        "listDashboards",
        "retrieveDashboard",
        "createDashboard",
        "updateDashboard",
        "deleteDashboardWidget",
        "default",
        "futureOperation",
        "toString",
        "__proto__",
      ]) {
        expect(resolveRunTokenCredential(operation, FALLBACK), operation).toBe(FALLBACK);
        expect(resolveRunTokenCredential(operation, undefined), operation).toBeUndefined();
      }
    });
  });

  it("falls back on missing, expired, malformed and old narrow tokens", async () => {
    await runInMockTaskContext(() => {
      const now = Math.floor(Date.now() / 1_000);
      for (const token of [
        undefined,
        "",
        "not-a-jwt",
        runToken({}, { typ: "JWT", alg: "RS256" }),
        runToken({ token_use: "public" }),
        runToken({ aud: ["trigger:api"] }),
        runToken({ aud: "other:api" }),
        runToken({ exp: undefined }),
        runToken({ exp: String(now + 60) }),
        runToken({ exp: null }),
        runToken({ exp: now }),
        runToken({ exp: now + 60 }),
        runToken({ exp: now - 1 }),
        runToken({ scopes: "admin" }),
        runToken({ scopes: ["admin", 1] }),
        runToken({ scopes: undefined }),
        runToken({ scopes: [] }),
        runToken({ scopes: ["trigger:tasks", "read:runs", "write:runs:run_self"] }),
        runToken().replace(/\.[^.]+\./, ".bnVsbA."),
      ]) {
        if (token === undefined) delete process.env.TRIGGER_RUN_TOKEN;
        else process.env.TRIGGER_RUN_TOKEN = token;
        expect(resolveRunTokenCredential("retrieveRun", FALLBACK)).toBe(FALLBACK);
        expect(resolveRunTokenCredential("retrieveRun", undefined)).toBeUndefined();
      }
    });
  });

  it("rereads environment on each request across rotation, invalidation and warm starts", async () => {
    await runInMockTaskContext(() => {
      const first = runToken({ jti: "first" });
      const rotated = runToken({ jti: "rotated" });
      process.env.TRIGGER_RUN_TOKEN = first;
      expect(resolveRunTokenCredential("retrieveRun", FALLBACK)).toBe(first);
      process.env.TRIGGER_RUN_TOKEN = rotated;
      expect(resolveRunTokenCredential("retrieveRun", FALLBACK)).toBe(rotated);
      process.env.TRIGGER_RUN_TOKEN = runToken({ exp: 1 });
      expect(resolveRunTokenCredential("retrieveRun", FALLBACK)).toBe(FALLBACK);
      delete process.env.TRIGGER_RUN_TOKEN;
      expect(resolveRunTokenCredential("retrieveRun", FALLBACK)).toBe(FALLBACK);
    });
    const nextRun = runToken({ jti: "warm-start" });
    process.env.TRIGGER_RUN_TOKEN = nextRun;
    await runInMockTaskContext(
      () => {
        expect(resolveRunTokenCredential("retrieveRun", FALLBACK)).toBe(nextRun);
      },
      { isWarmStart: true }
    );
  });

  it("never exports rollout metrics to a customer MeterProvider inside or outside tasks", async () => {
    class SelectionReader extends MetricReader {
      protected async onForceFlush(): Promise<void> {}
      protected async onShutdown(): Promise<void> {}
    }
    const reader = new SelectionReader();
    const provider = new MeterProvider({ readers: [reader] });
    metrics.disable();
    metrics.setGlobalMeterProvider(provider);
    try {
      const customerCounter = provider.getMeter("customer").createCounter("customer.requests");
      customerCounter.add(1);
      process.env.TRIGGER_RUN_TOKEN = runToken();
      resolveRunTokenCredential("retrieveRun", FALLBACK);
      await runInMockTaskContext(() => {
        resolveRunTokenCredential("retrieveRun", FALLBACK);
        resolveRunTokenCredential("unknown", FALLBACK);
        delete process.env.TRIGGER_RUN_TOKEN;
        resolveRunTokenCredential("retrieveRun", undefined);
      });
      const collected = await reader.collect();
      const metricNames = collected.resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .map((metric) => metric.descriptor.name);
      expect(metricNames).toEqual(["customer.requests"]);
    } finally {
      metrics.disable();
      await provider.shutdown();
    }
  });
});
