import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    UPLOADTHING_SECRET: z.string(),
    UPLOADTHING_APP_ID: z.string(),
    OPENAI_API_KEY: z.string(),
  },

  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
