import { packageOptions, defineConfig } from "@trigger.dev/tsup";

export default defineConfig({
  ...packageOptions,
  config: "tsconfig.build.json",
  entry: ["./src/index.ts", "./src/v3/index.ts", "./src/v3/otel/index.ts"],
});
