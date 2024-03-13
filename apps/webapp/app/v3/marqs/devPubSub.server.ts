import { z } from "zod";
import { singleton } from "~/utils/singleton";
import { ZodPubSub, ZodSubscriber } from "../utils/zodPubSub.server";
import { env } from "~/env.server";

const messageCatalog = {
  CANCEL_ATTEMPT: z.object({
    version: z.literal("v1").default("v1"),
    backgroundWorkerId: z.string(),
    attemptId: z.string(),
    taskRunId: z.string(),
  }),
};

export type DevSubscriber = ZodSubscriber<typeof messageCatalog>;

export const devPubSub = singleton("devPubSub", initializeDevPubSub);

function initializeDevPubSub() {
  return new ZodPubSub({
    redis: {
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    schema: {
      CANCEL_ATTEMPT: z.object({
        version: z.literal("v1").default("v1"),
        backgroundWorkerId: z.string(),
        attemptId: z.string(),
        taskRunId: z.string(),
      }),
    },
  });
}
