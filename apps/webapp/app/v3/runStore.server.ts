import { PostgresRunStore } from "@internal/run-store";
import { $replica, prisma } from "~/db.server";
import { singleton } from "~/utils/singleton";

export const runStore = singleton(
  "PostgresRunStore",
  () => new PostgresRunStore({ prisma, readOnlyPrisma: $replica })
);
