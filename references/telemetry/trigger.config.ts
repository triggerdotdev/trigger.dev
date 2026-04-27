import { defineConfig } from "@trigger.dev/sdk";
import { resourceFromAttributes } from "@opentelemetry/resources";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  telemetry: {
    resource: resourceFromAttributes({
      "foo.bar": "telemetry-test",
      "foo.baz": "1.0.0",
    }),
  },
});
