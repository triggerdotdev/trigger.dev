import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  runtime: "node",
  project: "proj_mpzmrzygzbvmfjnnpcsk",
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 5_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
  build: {
    extensions: [
      prismaExtension({
        schema: "prisma/schema.prisma",
        directUrlEnvVarName: "DIRECT_DATABASE_URL",
        typedSql: true,
      }),
    ],
  },
});
