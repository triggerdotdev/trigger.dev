import { z } from "zod";
import { singleton } from "~/utils/singleton";
import { ZodPubSub, ZodSubscriber } from "../utils/zodPubSub.server";
import { env } from "~/env.server";
import { Gauge } from "prom-client";
import { metricsRegister } from "~/metrics.server";

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
    name: "dev_pub_sub_subscribers",
    help: "Number of dev pub sub subscribers",
    collect() {
      this.set(pubSub.subscriberCount);
    },
    registers: [metricsRegister],
  });

  return pubSub;
}
