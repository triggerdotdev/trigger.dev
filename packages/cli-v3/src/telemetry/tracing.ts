import { BaselimeSDK } from "@baselime/node-opentelemetry";
import { trace } from "@opentelemetry/api";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const sdk = new BaselimeSDK({
  baselimeKey: "e9f963244f8b092850d42e34a5339b2d5e68070b".split("").reverse().join(""), // this is a joke
  instrumentations: [new FetchInstrumentation()],
  service: "cli-v3",
  serverless: true,
});

export function initializeTracing(): NodeTracerProvider {
  return sdk.start();
}

export function getTracer() {
  return trace.getTracer("cli-v3");
}
