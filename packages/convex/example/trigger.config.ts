import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_wcwcgcodbajkuocrovpq",
  runtime: "node-24",
  dirs: ["./trigger"],
  maxDuration: 120,
  retries: { default: { maxAttempts: 1 } },
  legacyDevProcessCwdBehaviour: false,
  build: {
    external: ["sharp"],
    extensions: [additionalFiles({ files: ["./public/samples/*.jpg"] })],
  },
});
