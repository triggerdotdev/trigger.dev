import { getMeter } from "@internal/tracing";
import { singleton } from "~/utils/singleton";

export type LogsSearchProjectionMode = "preview" | "finalized";
export type LogsSearchProjectionOutcome = "success" | "error";

const telemetry = singleton("logsSearchProjectorTelemetry", () => {
  const meter = getMeter("logs-search-projector");
  const values: {
    previewLagMs?: number;
    finalizedLagMs?: number;
    updatedAt?: number;
  } = {};
  const isFresh = () => values.updatedAt && Date.now() - values.updatedAt < 150_000;

  meter
    .createObservableGauge("logs_search.projector.preview_lag_ms", {
      description: "Delay between the preview cutoff and its best-effort Redis watermark",
    })
    .addCallback((result) => {
      if (isFresh() && values.previewLagMs !== undefined) result.observe(values.previewLagMs);
    });
  meter
    .createObservableGauge("logs_search.projector.finalized_lag_ms", {
      description: "Delay between the finalized cutoff and its durable checkpoint watermark",
    })
    .addCallback((result) => {
      if (isFresh() && values.finalizedLagMs !== undefined) result.observe(values.finalizedLagMs);
    });
  return {
    values,
    windows: meter.createCounter("logs_search.projector.windows", {
      description: "Logs search projection windows by mode and outcome",
    }),
    duration: meter.createHistogram("logs_search.projector.window_duration_ms", {
      description: "Duration of one logs search projection window",
    }),
    sourceRows: meter.createHistogram("logs_search.projector.source_rows", {
      description: "Source rows read for one logs search projection window",
    }),
    destinationRows: meter.createHistogram("logs_search.projector.destination_rows", {
      description: "Rows written for one logs search projection window",
    }),
    leaseContention: meter.createCounter("logs_search.projector.lease_contention"),
    checkpointConflicts: meter.createCounter("logs_search.projector.checkpoint_conflicts"),
    previewSkipped: meter.createCounter("logs_search.projector.preview_skipped_windows"),
  };
});

export const logsSearchProjectorTelemetry = {
  recordWindow(
    mode: LogsSearchProjectionMode,
    outcome: LogsSearchProjectionOutcome,
    durationMs: number,
    sourceRows = 0,
    destinationRows = 0
  ) {
    telemetry.windows.add(1, { mode, outcome });
    telemetry.duration.record(durationMs, { mode, outcome });
    telemetry.sourceRows.record(sourceRows, { mode });
    telemetry.destinationRows.record(destinationRows, { mode });
  },
  recordLeaseContention(mode: LogsSearchProjectionMode) {
    telemetry.leaseContention.add(1, { mode });
  },
  recordCheckpointConflict() {
    telemetry.checkpointConflicts.add(1);
  },
  recordPreviewSkipped(count: number) {
    telemetry.previewSkipped.add(count);
  },
  updateState(values: { previewLagMs: number | null; finalizedLagMs: number }) {
    if (values.previewLagMs !== null) {
      telemetry.values.previewLagMs = Math.max(0, values.previewLagMs);
    }
    telemetry.values.finalizedLagMs = Math.max(0, values.finalizedLagMs);
    telemetry.values.updatedAt = Date.now();
  },
};
