import { metrics } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { TracingSDK } from "./tracingSDK.js";

describe("TracingSDK shutdown", () => {
  it("leaves the meter provider shut down", async () => {
    const tracingSDK = new TracingSDK({
      url: "http://localhost:1",
      forceFlushTimeoutMillis: 5_000,
      diagLogLevel: "none",
    });

    const meterBeforeShutdown = metrics.getMeter("test");

    await tracingSDK.shutdown().catch(() => {});

    expect(metrics.getMeter("test")).not.toBe(meterBeforeShutdown);
  });
});
