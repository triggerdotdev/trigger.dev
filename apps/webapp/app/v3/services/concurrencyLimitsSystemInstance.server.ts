import { prisma, $replica } from "~/db.server";
import { env } from "~/env.server";
import { ConcurrencyLimitsSystem } from "./concurrencyLimitsSystem.server";
import { singleton } from "~/utils/singleton";

export const concurrencyLimitsSystem = singleton(
  "concurrency-limits-system",
  initializeConcurrencyLimitsSystemInstance
);

function initializeConcurrencyLimitsSystemInstance() {
  return new ConcurrencyLimitsSystem({
    db: prisma,
    reader: $replica,
    keyOverridesEnabled: env.RUN_ENGINE_CONCURRENCY_KEY_LIMITS_ENABLED === "1",
  });
}
