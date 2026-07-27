import { defineConfig } from "@trigger.dev/sdk";

// The project ref is passed on the CLI (`-p <ref>`) at deploy time, so it is not
// hard-coded here. This keeps the harness portable and secret-free in the repo.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_REPLACE_ME",
  runtime: "node",
  logLevel: "info",
  maxDuration: 120,
  dirs: ["./src/trigger"],
});
