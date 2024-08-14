import { z } from "zod";
import { singleton } from "~/utils/singleton";
import { ZodPubSub, ZodSubscriber } from "../utils/zodPubSub.server";
import { env } from "~/env.server";
import { Gauge } from "prom-client";
import { metricsRegister } from "~/metrics.server";

const messageCatalog = {
  WORKER_CREATED: z.object({
    environmentId: z.string(),
    environmentType: z.string(),
    createdAt: z.coerce.date(),
    taskCount: z.number(),
    type: z.union([z.literal("local"), z.literal("deployed")]),
  }),
};

export type ProjectSubscriber = ZodSubscriber<typeof messageCatalog>;

export const projectPubSub = singleton("projectPubSub", initializeProjectPubSub);

function initializeProjectPubSub() {
  const pubSub = new ZodPubSub({
    redis: {
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      // Force support for both IPv6 and IPv4, by default ioredis sets this to 4,
      // only allowing IPv4 connections:
      // https://github.com/redis/ioredis/issues/1576
      family: 0,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    schema: messageCatalog,
  });

  new Gauge({
    name: "project_pub_sub_subscribers",
    help: "Number of project pub sub subscribers",
    collect() {
      this.set(pubSub.subscriberCount);
    },
    registers: [metricsRegister],
  });

  return pubSub;
}
