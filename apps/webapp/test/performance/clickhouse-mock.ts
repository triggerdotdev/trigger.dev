import type { RawTaskRunPayloadV1, TaskRunV2 } from "@internal/clickhouse";

/**
 * Mock ClickHouse client for CPU-only profiling.
 * Implements the minimal interface needed by RunsReplicationService
 * without actually writing to ClickHouse.
 */
export class MockClickHouse {
  private insertCount = 0;
  private payloadInsertCount = 0;

  constructor(private readonly insertDelayMs: number = 0) {}

  taskRuns = {
    insert: async (
      runs: TaskRunV2[],
      options?: any
    ): Promise<[Error | null, { rows: number } | null]> => {
      if (this.insertDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.insertDelayMs));
      }

      this.insertCount += runs.length;

      return [null, { rows: runs.length }];
    },

    insertPayloads: async (
      payloads: RawTaskRunPayloadV1[],
      options?: any
    ): Promise<[Error | null, { rows: number } | null]> => {
      if (this.insertDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.insertDelayMs));
      }

      this.payloadInsertCount += payloads.length;

      return [null, { rows: payloads.length }];
    },
  };

  getStats() {
    return {
      totalInserts: this.insertCount,
      totalPayloadInserts: this.payloadInsertCount,
    };
  }

  reset() {
    this.insertCount = 0;
    this.payloadInsertCount = 0;
  }
}
