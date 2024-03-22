import { packageOptions, defineConfig } from "@trigger.dev/tsup";

export default defineConfig({
  ...packageOptions,
  config: "tsconfig.build.json",
  banner: {
    js: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
  },
});
