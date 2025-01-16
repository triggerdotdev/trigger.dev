import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "<fixture project>",
  dirs: ["./src/trigger"],
  build: {
    external: ["mupdf"],
  },
  maxDuration: 3600,
});
