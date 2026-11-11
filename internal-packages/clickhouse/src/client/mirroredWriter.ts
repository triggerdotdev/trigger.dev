import type { Result } from "@trigger.dev/core/v3";
import type { Logger } from "@trigger.dev/core/logger";
import type { ClickhouseWriter } from "./types.js";

/** Mirror writes still in flight beyond this are skipped so a dead mirror cannot pile up request bodies. */
const MAX_IN_FLIGHT_MIRROR_WRITES = 64;

/**
 * Sends every write to the primary writer and, once the primary has accepted the batch, to the
 * mirror, so a data store can be migrated to another ClickHouse service without a gap. Callers get
 * the primary's result as soon as it settles. Mirror writes are issued only after the primary
 * succeeds (so a retried primary failure never leaves extra copies on the mirror), are detached,
 * have their failures only logged, and at most {@link MAX_IN_FLIGHT_MIRROR_WRITES} are in flight
 * at once (later batches are skipped and logged). The mirror can therefore never slow or fail the
 * primary path; rows it misses are reconciled by the copy tool. `close` closes both clients
 * without waiting for in-flight mirror writes.
 */
export class MirroredClickhouseWriter implements ClickhouseWriter {
  private inFlightMirrorWrites = 0;

  constructor(
    private readonly primary: ClickhouseWriter,
    private readonly mirror: ClickhouseWriter,
    private readonly logger: Logger
  ) {}

  private mirrored<TArgs extends any[], TOut, TErr>(
    operation: { name: string; table?: string },
    primaryFn: (...args: TArgs) => Promise<Result<TOut, TErr>>,
    mirrorFn: (...args: TArgs) => Promise<Result<TOut, TErr>>
  ): (...args: TArgs) => Promise<Result<TOut, TErr>> {
    return async (...args) => {
      const primaryResult = await primaryFn(...args);
      if (primaryResult[0]) return primaryResult;

      const fields = { name: operation.name, table: operation.table };
      if (this.inFlightMirrorWrites >= MAX_IN_FLIGHT_MIRROR_WRITES) {
        this.logger.error("Mirror ClickHouse write skipped; too many in flight", {
          ...fields,
          inFlight: this.inFlightMirrorWrites,
        });
        return primaryResult;
      }

      this.inFlightMirrorWrites++;
      mirrorFn(...args)
        .then(([error]) => {
          if (error) this.logger.error("Mirror ClickHouse write failed", { ...fields, error });
        })
        .catch((error) => this.logger.error("Mirror ClickHouse write failed", { ...fields, error }))
        .finally(() => {
          this.inFlightMirrorWrites--;
        });

      return primaryResult;
    };
  }

  command: ClickhouseWriter["command"] = (req) =>
    this.mirrored(req, this.primary.command(req), this.mirror.command(req));

  insert: ClickhouseWriter["insert"] = (req) =>
    this.mirrored(req, this.primary.insert(req), this.mirror.insert(req));

  insertUnsafe: ClickhouseWriter["insertUnsafe"] = (req) =>
    this.mirrored(req, this.primary.insertUnsafe(req), this.mirror.insertUnsafe(req));

  insertCompact: ClickhouseWriter["insertCompact"] = (req) =>
    this.mirrored(req, this.primary.insertCompact(req), this.mirror.insertCompact(req));

  insertCompactRaw: ClickhouseWriter["insertCompactRaw"] = (req) =>
    this.mirrored(req, this.primary.insertCompactRaw(req), this.mirror.insertCompactRaw(req));

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.mirror.close()]);
  }
}
