import { createEnv } from "@t3-oss/env-core";
import { logger, task } from "@trigger.dev/sdk/v3";
import { z } from "zod";

// uncomment to trigger deploy failures
export const env = createEnv({
  clientPrefix: "NEXT_PUBLIC_",
  server: {
    SECRET_DATABASE_URL: z.string().url(),
  },
  client: {
    // NEXT_PUBLIC_SOME_PUBKEY: z.string().min(1),
  },
  runtimeEnv: {
    // NEXT_PUBLIC_SOME_PUBKEY: process.env.NEXT_PUBLIC_SOME_PUBKEY,
  },
});

export const simplestTask = task({
  id: "t3-env-test",
  run: async (payload: any) => {
    logger.info("Environment variables", env);
  },
});
