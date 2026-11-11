import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import {
  registerWaitpointKeyTransactionLane,
  WaitpointKeyTransactionLane,
  WAITPOINT_KEY_TRANSACTION_POOL_SIZE,
} from "@internal/run-store";

/** A real, isolated keyed-creation pool for engine integration tests. */
export function registerTestKeyLane(client: PrismaClient, databaseUrl: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", String(WAITPOINT_KEY_TRANSACTION_POOL_SIZE));
  const lane = new WaitpointKeyTransactionLane(
    () => new PrismaClient({ datasources: { db: { url: url.toString() } } })
  );
  registerWaitpointKeyTransactionLane(client, lane);
  return lane;
}

export const keyedWaitpointTest = containerTestWithIsolatedRedis.extend({
  prisma: async ({ postgresContainer }, use) => {
    const url = postgresContainer.getConnectionUri();
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    const lane = registerTestKeyLane(prisma, url);
    try {
      await use(prisma);
    } finally {
      await lane.close();
      await prisma.$disconnect();
    }
  },
});
