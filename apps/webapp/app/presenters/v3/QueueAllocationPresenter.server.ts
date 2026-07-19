import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { sqlDatabaseSchema } from "~/db.server";
import { BasePresenter } from "./basePresenter.server";

export type QueueAllocation = {
  /** Number of V2 queues in the environment. */
  totalQueues: number;
  /** Sum of explicit per-queue limits, each clamped to the env limit. */
  allocated: number;
  /** Queues with no explicit limit (they float up to the env limit). */
  unlimitedCount: number;
};

/**
 * Environment-wide allocation totals for the queues page summary tiles.
 *
 * The page only needs the aggregate `allocated` value (sum of each queue's
 * explicit limit clamped to the env limit), so this computes it in a single
 * Postgres aggregate over ALL V2 queues in the environment — no row cap and no
 * Redis lookups.
 */
export class QueueAllocationPresenter extends BasePresenter {
  public async call({
    environment,
  }: {
    environment: AuthenticatedEnvironment;
  }): Promise<QueueAllocation> {
    const envLimit = environment.maximumConcurrencyLimit;

    const [row] = await this._replica.$queryRaw<
      {
        totalQueues: number;
        allocated: number;
        unlimitedCount: number;
      }[]
    >`
      SELECT
        COUNT(*)::int AS "totalQueues",
        COUNT(*) FILTER (WHERE "concurrencyLimit" IS NULL)::int AS "unlimitedCount",
        COALESCE(
          SUM(LEAST("concurrencyLimit", ${envLimit}))
            FILTER (WHERE "concurrencyLimit" IS NOT NULL),
          0
        )::int AS "allocated"
      FROM ${sqlDatabaseSchema}."TaskQueue"
      WHERE "runtimeEnvironmentId" = ${environment.id}
        AND "version" = 'V2'
    `;

    return {
      totalQueues: row?.totalQueues ?? 0,
      allocated: row?.allocated ?? 0,
      unlimitedCount: row?.unlimitedCount ?? 0,
    };
  }
}
