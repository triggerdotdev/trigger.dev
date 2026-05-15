import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  runtime: "node-22",
  processKeepAlive: {
    enabled: true,
    maxExecutionsPerProcess: 50,
  },
  build: {
    extensions: [
      prismaExtension({
        mode: "modern",
      }),
    ],
    keepNames: false,
  },
});
