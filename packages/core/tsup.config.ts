import { packageOptions, defineConfig } from "@trigger.dev/tsup";

export default defineConfig({
  ...packageOptions,
  config: "tsconfig.build.json",
});
