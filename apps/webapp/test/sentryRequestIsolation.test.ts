import { context } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import * as Sentry from "@sentry/remix";
import { SentryContextManager } from "@sentry/remix";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Two overlapping requests, each tagging its own isolation scope, mirroring what
 * `SentryHttpInstrumentation` does per incoming request. Returns what each one
 * reads back after the other has started.
 */
async function raceTwoRequests(): Promise<Record<string, unknown>> {
  const observed: Record<string, unknown> = {};

  const handleRequest = (name: string, holdMs: number) =>
    Sentry.withIsolationScope(async () => {
      Sentry.getIsolationScope().setTag("request", name);
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      observed[name] = Sentry.getIsolationScope().getScopeData().tags.request;
    });

  await Promise.all([handleRequest("slow", 30), handleRequest("fast", 5)]);

  return observed;
}

describe("Sentry request isolation", () => {
  beforeAll(() => {
    Sentry.init({ dsn: undefined, defaultIntegrations: false, skipOpenTelemetrySetup: true });
  });

  afterEach(() => {
    context.disable();
  });

  it("leaks the isolation scope between concurrent requests without SentryContextManager", async () => {
    new NodeTracerProvider().register();

    const observed = await raceTwoRequests();

    expect(observed).toEqual({ slow: "fast", fast: "fast" });
  });

  it("keeps each request's isolation scope separate with SentryContextManager", async () => {
    new NodeTracerProvider().register({ contextManager: new SentryContextManager() });

    const observed = await raceTwoRequests();

    expect(observed).toEqual({ slow: "slow", fast: "fast" });
  });
});
