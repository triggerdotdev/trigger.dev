import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "json-schema-test",
  retries: {
    enabledInDev: false,
  },
  triggerDirectories: ["./src/trigger"],
});