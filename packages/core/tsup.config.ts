import { packageOptions, defineConfig } from "@trigger.dev/tsup";

export default defineConfig({
  ...packageOptions,
  config: "tsconfig.build.json",
  entry: [
    "./src/index.ts",
    "./src/v3/index.ts",
    "./src/v3/otel/index.ts",
    "./src/v3/zodMessageHandler.ts",
    "./src/v3/zodNamespace.ts",
    "./src/v3/zodSocket.ts",
    "./src/v3/zodIpc.ts",
    "./src/v3/utils/structuredLogger.ts",
    "./src/v3/dev/index.ts",
    "./src/v3/prod/index.ts",
    "./src/v3/workers/index.ts",
    "./src/v3/zodfetch.ts",
  ],
});
