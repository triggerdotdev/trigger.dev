import { defineConfig } from "@trigger.dev/sdk/v3";
import { rscExtension } from "@trigger.dev/rsc";
import { AISDKExporter } from "langsmith/vercel";

export default defineConfig({
  project: "proj_bzhdaqhlymtuhlrcgbqy",
  dirs: ["./src/trigger"],
  telemetry: {
    exporters: [new AISDKExporter()],
  },
  build: {
    extensions: [rscExtension({ reactDomEnvironment: "worker" })],
  },
  maxDuration: 3600,
});
