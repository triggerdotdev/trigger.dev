import type { PrismaClient, TaskRun } from "@trigger.dev/database";
import KSUID from "ksuid";

/**
 * Parsed run ID with format and routing information
 */
export type ParsedRunId =
  | {
      format: "ksuid";
      table: "partitioned";
      timestamp: Date;
      region: string;
      version: string;
    }
  | {
      format: "nanoid";
      table: "legacy";
    };

/**
 * TaskRunRouter routes TaskRun queries to the correct table based on ID format.
 *
 * During the transition period:
 * - Legacy runs (nanoid format): Query TaskRun table
 * - New runs (KSUID format): Query TaskRunPartitioned table (Phase 2+)
 *
 * The router inspects the friendlyId to determine which table to query:
 * - Legacy format: run_<21-char-nanoid> (25 chars total)
 * - New format: run_<27-char-ksuid><1-char-region><1-char-version> (33 chars total)
 */
export class TaskRunRouter {
  #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  /**
   * Parse a run friendlyId to determine its format and target table.
   *
   * @param friendlyId - The run's friendly ID (e.g., "run_abc123...")
   * @returns Parsed ID information including format and target table
   */
  parseRunId(friendlyId: string): ParsedRunId {
    if (!friendlyId.startsWith("run_")) {
      // Assume legacy format for backwards compatibility
      return { format: "nanoid", table: "legacy" };
    }

    const suffix = friendlyId.slice(4); // Remove "run_"

    // New KSUID format: 27-char KSUID + 1-char region + 1-char version = 29 chars
    if (suffix.length === 29) {
      try {
        const ksuidPart = suffix.slice(0, 27);
        const ksuid = KSUID.parse(ksuidPart);
        return {
          format: "ksuid",
          table: "partitioned",
          timestamp: ksuid.date,
          region: suffix[27],
          version: suffix[28],
        };
      } catch {
        // If KSUID parsing fails, treat as legacy
        return { format: "nanoid", table: "legacy" };
      }
    }

    // Legacy nanoid format: 21 chars
    return { format: "nanoid", table: "legacy" };
  }

  /**
   * Check if a friendlyId uses the new KSUID format (partitioned table)
   */
  isPartitioned(friendlyId: string): boolean {
    const parsed = this.parseRunId(friendlyId);
    return parsed.format === "ksuid";
  }

  /**
   * Find a single run by friendlyId
   */
  async findByFriendlyId(friendlyId: string): Promise<TaskRun | null> {
    const parsed = this.parseRunId(friendlyId);

    if (parsed.format === "ksuid") {
      // Phase 2+: Query partitioned table with timestamp hint for partition pruning
      // For now, partitioned table doesn't exist, so return null
      // TODO: Uncomment when TaskRunPartitioned table is created
      // const dayMs = 86400000;
      // return this.#prisma.taskRunPartitioned.findFirst({
      //   where: {
      //     friendlyId,
      //     createdAt: {
      //       gte: new Date(parsed.timestamp.getTime() - dayMs),
      //       lte: new Date(parsed.timestamp.getTime() + dayMs),
      //     },
      //   },
      // });
      return null;
    }

    // Legacy format - query TaskRun table
    return this.#prisma.taskRun.findFirst({ where: { friendlyId } });
  }

  /**
   * Find a single run by internal ID.
   *
   * Since internal IDs don't encode the table, we query legacy first
   * (most common during transition), then partitioned if not found.
   */
  async findById(id: string): Promise<TaskRun | null> {
    // Query legacy table first (most common during transition)
    const legacyRun = await this.#prisma.taskRun.findFirst({ where: { id } });
    if (legacyRun) {
      return legacyRun;
    }

    // Phase 2+: Query partitioned table
    // TODO: Uncomment when TaskRunPartitioned table is created
    // return this.#prisma.taskRunPartitioned.findFirst({ where: { id } });
    return null;
  }

  /**
   * Find multiple runs by internal IDs (mixed tables supported).
   *
   * Queries both tables in parallel and merges results.
   */
  async findByIds(ids: string[]): Promise<TaskRun[]> {
    if (ids.length === 0) return [];

    // Phase 1: Only legacy table exists
    const legacyRuns = await this.#prisma.taskRun.findMany({
      where: { id: { in: ids } },
    });

    // Phase 2+: Query both tables in parallel
    // const [legacyRuns, partitionedRuns] = await Promise.all([
    //   this.#prisma.taskRun.findMany({ where: { id: { in: ids } } }),
    //   this.#prisma.taskRunPartitioned.findMany({ where: { id: { in: ids } } }),
    // ]);
    // return [...legacyRuns, ...partitionedRuns];

    return legacyRuns;
  }

  /**
   * Find multiple runs by friendlyIds (mixed tables supported).
   *
   * Separates IDs by format and queries appropriate tables.
   */
  async findByFriendlyIds(friendlyIds: string[]): Promise<TaskRun[]> {
    if (friendlyIds.length === 0) return [];

    // Separate IDs by format
    const ksuidIds: string[] = [];
    const nanoidIds: string[] = [];

    for (const id of friendlyIds) {
      const parsed = this.parseRunId(id);
      if (parsed.format === "ksuid") {
        ksuidIds.push(id);
      } else {
        nanoidIds.push(id);
      }
    }

    const results: TaskRun[] = [];

    // Phase 2+: Query partitioned table for KSUID IDs
    // if (ksuidIds.length > 0) {
    //   const partitioned = await this.#prisma.taskRunPartitioned.findMany({
    //     where: { friendlyId: { in: ksuidIds } },
    //   });
    //   results.push(...partitioned);
    // }

    // Query legacy table for nanoid IDs
    if (nanoidIds.length > 0) {
      const legacy = await this.#prisma.taskRun.findMany({
        where: { friendlyId: { in: nanoidIds } },
      });
      results.push(...legacy);
    }

    return results;
  }

  /**
   * Update a run by friendlyId (routes to correct table).
   */
  async updateByFriendlyId(
    friendlyId: string,
    data: Parameters<PrismaClient["taskRun"]["update"]>[0]["data"]
  ): Promise<TaskRun> {
    const parsed = this.parseRunId(friendlyId);

    if (parsed.format === "ksuid") {
      // Phase 2+: Update in partitioned table
      // return this.#prisma.taskRunPartitioned.update({
      //   where: { friendlyId },
      //   data,
      // });
      throw new Error(`Cannot update partitioned run ${friendlyId}: partitioned table not yet available`);
    }

    return this.#prisma.taskRun.update({
      where: { friendlyId },
      data,
    });
  }

  /**
   * Update a run by internal ID (routes to correct table).
   *
   * Since internal IDs don't encode the table, we try legacy first.
   */
  async updateById(
    id: string,
    data: Parameters<PrismaClient["taskRun"]["update"]>[0]["data"]
  ): Promise<TaskRun> {
    // Try legacy table first
    try {
      return await this.#prisma.taskRun.update({
        where: { id },
        data,
      });
    } catch (error) {
      // Phase 2+: Try partitioned table if not found in legacy
      // try {
      //   return await this.#prisma.taskRunPartitioned.update({
      //     where: { id },
      //     data,
      //   });
      // } catch {
      //   throw error; // Rethrow original error
      // }
      throw error;
    }
  }
}
