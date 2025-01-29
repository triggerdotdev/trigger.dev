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
      port: env.PUBSUB_REDIS_PORT,
      host: env.PUBSUB_REDIS_HOST,
      username: env.PUBSUB_REDIS_USERNAME,
      password: env.PUBSUB_REDIS_PASSWORD,
      tlsDisabled: env.PUBSUB_REDIS_TLS_DISABLED === "true",
      clusterMode: env.PUBSUB_REDIS_CLUSTER_MODE_ENABLED === "1",
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
