import { BaselimeSDK } from "@baselime/node-opentelemetry";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const sdk = new BaselimeSDK({
  baselimeKey: "e9f963244f8b092850d42e34a5339b2d5e68070b".split("").reverse().join(""), // this is a joke
  instrumentations: [new FetchInstrumentation()],
  service: "cli-v3",
  serverless: true,
});

export const provider: NodeTracerProvider = sdk.start();
export const tracer = provider.getTracer("cli-v3");
