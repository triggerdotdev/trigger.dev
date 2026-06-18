import { defineConfig } from "@trigger.dev/sdk";

/**
 * The dashboard agent is its own Trigger project, deployed independently of the
 * webapp. It deliberately does NOT live inside apps/webapp: the agent has no
 * access to the main database, ClickHouse, or webapp internals (it reads
 * everything via the API), and keeping it in a separate package makes that
 * firewall structural rather than a convention.
 *
 * The project ref is read from the environment so no cloud project ref is
 * committed to this public repo. For local dev, set
 * TRIGGER_DASHBOARD_AGENT_PROJECT_REF to a project you own and run the CLI from
 * this directory.
 */
export default defineConfig({
  project: process.env.TRIGGER_DASHBOARD_AGENT_PROJECT_REF ?? "",
  dirs: ["./src"],
  compatibilityFlags: ["run_engine_v2"],
  maxDuration: 3600,
});
