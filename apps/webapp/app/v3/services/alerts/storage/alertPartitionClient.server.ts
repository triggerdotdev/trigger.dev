import { createAlertPartitionPrisma, type PrismaClient } from "~/db.server";
import type { AlertPartitionDdlClient } from "../engine/alertPartitionMaintenance.server";

let client: PrismaClient | undefined;

export const alertPartitionDdlClient: AlertPartitionDdlClient = {
  get() {
    client ??= createAlertPartitionPrisma();
    return client;
  },
  async discard() {
    const current = client;
    client = undefined;
    if (!current) return;
    await Promise.race([
      current.$disconnect().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  },
};
