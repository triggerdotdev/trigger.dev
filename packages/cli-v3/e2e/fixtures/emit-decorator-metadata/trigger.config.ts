import { defineConfig } from "@trigger.dev/sdk/v3";
import { emitDecoratorMetadata } from "@trigger.dev/build/extensions/typescript";

export default defineConfig({
  project: "<fixture project>",
  dirs: ["./src/trigger"],
  build: {
    extensions: [emitDecoratorMetadata()],
  },
  maxDuration: 3600,
});
