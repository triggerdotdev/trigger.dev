import { defineConfig } from "@trigger.dev/sdk/v3";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { libreoffice } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  compatibilityFlags: ["run_engine_v2"],
  project: "proj_rrkpdguyagvsoktglnod",
  logLevel: "debug",
  build: {
    extensions: [
      syncEnvVars(),
      libreoffice(),
    ],
  },
});