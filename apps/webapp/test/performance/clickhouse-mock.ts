import type { ClickHouse, TaskRunInsertArray, PayloadInsertArray } from "@internal/clickhouse";

// Minimal InsertResult type to avoid dependency on @clickhouse/client
interface InsertResult {
  executed: boolean;
  query_id: string;
  summary?: {
    read_rows: string;
    read_bytes: string;
    written_rows: string;
    written_bytes: string;
    total_rows_to_read: string;
    result_rows: string;
    result_bytes: string;
    elapsed_ns: string;
  };
  response_headers: Record<string, string>;
}

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
    insertCompactArrays: async (
      rows: TaskRunInsertArray[],
      options?: any
    ): Promise<[Error | null, InsertResult | null]> => {
      if (this.insertDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.insertDelayMs));
      }

      this.insertCount += rows.length;

      return [
        null,
        {
          executed: true,
          query_id: "mock",
          summary: {
            read_rows: "0",
            read_bytes: "0",
            written_rows: String(rows.length),
            written_bytes: "0",
            total_rows_to_read: "0",
            result_rows: "0",
            result_bytes: "0",
            elapsed_ns: "0",
          },
          response_headers: {},
        },
      ];
    },

    insertPayloadsCompactArrays: async (
      rows: PayloadInsertArray[],
      options?: any
    ): Promise<[Error | null, InsertResult | null]> => {
      if (this.insertDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.insertDelayMs));
      }

      this.payloadInsertCount += rows.length;

      return [
        null,
        {
          executed: true,
          query_id: "mock",
          summary: {
            read_rows: "0",
            read_bytes: "0",
            written_rows: String(rows.length),
            written_bytes: "0",
            total_rows_to_read: "0",
            result_rows: "0",
            result_bytes: "0",
            elapsed_ns: "0",
          },
          response_headers: {},
        },
      ];
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

// Type assertion helper for use with RunsReplicationService
export function asMockClickHouse(mock: MockClickHouse): Pick<ClickHouse, "taskRuns"> {
  return mock as unknown as Pick<ClickHouse, "taskRuns">;
}
