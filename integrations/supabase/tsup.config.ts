import { defineConfig, deepMergeOptions, integrationOptions } from "@trigger.dev/tsup";

const options = deepMergeOptions(integrationOptions, {
  // extend base config here
});

export default defineConfig(options);
