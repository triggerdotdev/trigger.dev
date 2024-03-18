import { BaselimeSDK } from "@baselime/node-opentelemetry";
import { trace } from "@opentelemetry/api";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import * as packageJson from "../../package.json";

const sdk = new BaselimeSDK({
  baselimeKey: "e9f963244f8b092850d42e34a5339b2d5e68070b".split("").reverse().join(""), // this is a joke
  instrumentations: [new FetchInstrumentation()],
  service: "cli-v3",
  serverless: true,
});

function initializeTracing(): NodeTracerProvider | undefined {
  if (!process.argv.includes("--skip-telemetry")) {
    return sdk.start();
  }
}

export const provider = initializeTracing();

export function getTracer() {
  return trace.getTracer("trigger.dev cli", packageJson.version);
}
