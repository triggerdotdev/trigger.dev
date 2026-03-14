import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  dirs: ["./src/trigger"],
  maxDuration: 300,
  build: {
    extensions: [
      prismaExtension({
        mode: "modern",
      }),
    ],
  },
});
