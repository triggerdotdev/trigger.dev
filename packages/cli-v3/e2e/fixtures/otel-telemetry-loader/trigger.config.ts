import { defineConfig } from "@trigger.dev/sdk/v3";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";

export default defineConfig({
  project: "<fixture project>",
  dirs: ["./src/trigger"],
  instrumentations: [new OpenAIInstrumentation()],
  maxDuration: 3600,
});
