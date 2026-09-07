import { prisma, $replica } from "~/db.server";
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
  });
}
