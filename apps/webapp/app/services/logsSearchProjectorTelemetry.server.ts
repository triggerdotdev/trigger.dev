import { getMeter } from "@internal/tracing";
import { singleton } from "~/utils/singleton";

export type LogsSearchProjectionMode = "live" | "backfill";
export type LogsSearchProjectionOutcome = "success" | "error" | "cas_lost";

const telemetry = singleton("logsSearchProjectorTelemetry", () => {
  const meter = getMeter("logs-search-projector");
  const values: {
    liveLagMs?: number;
    backfillRemaining?: number;
    paused?: number;
    updatedAt?: number;
  } = {};
  const isFresh = () => values.updatedAt && Date.now() - values.updatedAt < 150_000;

  meter
    .createObservableGauge("logs_search.projector.live_lag_ms", {
      description: "Delay between the safe projection cutoff and the live watermark",
    })
    .addCallback((result) => {
      if (isFresh() && values.liveLagMs !== undefined) result.observe(values.liveLagMs);
    });
  meter
    .createObservableGauge("logs_search.projector.backfill_remaining_windows", {
      description: "One-minute windows remaining in the active historical backfill",
    })
    .addCallback((result) => {
      if (isFresh() && values.backfillRemaining !== undefined) {
        result.observe(values.backfillRemaining);
      }
    });
  meter
    .createObservableGauge("logs_search.projector.paused", {
      description: "Whether the logs search projector is paused",
    })
    .addCallback((result) => {
      if (isFresh() && values.paused !== undefined) result.observe(values.paused);
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
    casLoss: meter.createCounter("logs_search.projector.cas_loss"),
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
  recordLeaseContention() {
    telemetry.leaseContention.add(1);
  },
  recordCasLoss(mode: LogsSearchProjectionMode) {
    telemetry.casLoss.add(1, { mode });
  },
  updateState(values: { liveLagMs: number; backfillRemaining: number; paused: boolean }) {
    telemetry.values.liveLagMs = Math.max(0, values.liveLagMs);
    telemetry.values.backfillRemaining = Math.max(0, values.backfillRemaining);
    telemetry.values.paused = values.paused ? 1 : 0;
    telemetry.values.updatedAt = Date.now();
  },
};
