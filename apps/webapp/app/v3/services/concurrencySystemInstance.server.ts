import { prisma, $replica } from "~/db.server";
import { ConcurrencySystem } from "./concurrencySystem.server";
import { singleton } from "~/utils/singleton";

export const concurrencySystem = singleton(
  "concurrency-system",
  initalizeConcurrencySystemInstance
);

function initalizeConcurrencySystemInstance() {
  return new ConcurrencySystem({
    db: prisma,
    reader: $replica,
  });
}
