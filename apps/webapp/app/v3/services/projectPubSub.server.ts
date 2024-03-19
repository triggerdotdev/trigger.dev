import { z } from "zod";
import { singleton } from "~/utils/singleton";
import { ZodPubSub, ZodSubscriber } from "../utils/zodPubSub.server";
import { env } from "~/env.server";

const messageCatalog = {
  WORKER_CREATED: z.object({
    environmentId: z.string(),
    environmentType: z.string(),
    createdAt: z.coerce.date(),
    taskCount: z.number(),
  }),
};

export type ProjectSubscriber = ZodSubscriber<typeof messageCatalog>;

export const projectPubSub = singleton("projectPubSub", initializeProjectPubSub);

function initializeProjectPubSub() {
  return new ZodPubSub({
    redis: {
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    schema: messageCatalog,
  });
}
