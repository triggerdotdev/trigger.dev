import type { PrismaClient } from "@trigger.dev/database";
import type {
  PendingVersionRunIdLookup,
  PendingVersionRunIdLookupOptions,
  PendingVersionRunIdLookupResult,
} from "../services/pendingVersionLookup.js";

/**
 * Test-only Postgres-backed lookup. Performs the same query the system
 * used to issue directly before the ClickHouse migration. Lets the
 * existing pendingVersion tests keep exercising the end-to-end transition
 * without spinning up a ClickHouse container.
 *
 * Not exported from the package — for in-package tests only.
 */
export class PostgresPendingVersionRunIdLookup implements PendingVersionRunIdLookup {
  readonly name = "test-postgres";

  constructor(private readonly prisma: PrismaClient) {}

  async lookupPendingVersionRunIds(
    options: PendingVersionRunIdLookupOptions
  ): Promise<PendingVersionRunIdLookupResult> {
    if (options.taskIdentifiers.length === 0 || options.queues.length === 0) {
      return { runIds: [] };
    }

    const rows = await this.prisma.taskRun.findMany({
      where: {
        runtimeEnvironmentId: options.environmentId,
        projectId: options.projectId,
        status: "PENDING_VERSION",
        taskIdentifier: { in: options.taskIdentifiers },
        queue: { in: options.queues },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: options.limit,
    });

    return { runIds: rows.map((r) => r.id) };
  }
}
