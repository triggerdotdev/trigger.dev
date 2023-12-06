import { packageOptions } from "@trigger.dev/tsup";
import { defineConfig } from "@trigger.dev/tsup";

export default defineConfig({ ...packageOptions, config: "tsconfig.build.json" });
