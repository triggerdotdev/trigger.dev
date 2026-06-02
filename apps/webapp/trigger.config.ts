import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  dirs: ["./app/trigger"],
  maxDuration: 3600,
  runtime: "node-22",
});
