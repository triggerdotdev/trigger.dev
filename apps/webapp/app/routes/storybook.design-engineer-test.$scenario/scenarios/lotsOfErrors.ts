import type { TaskRunError, TaskRunErrorCause } from "@trigger.dev/core/v3";
import {
  attempt,
  batchTriggerAndWait,
  batchTriggerAndWaitTasks,
  buildRunPageScenario,
  httpRequest,
  log,
  run,
  runFunction,
  span,
  triggerAndWait,
  type RunOptions,
} from "../mockTrace";

// Like the fan out, but a lot goes wrong. The nightly sync triggers a batch of jobs and waits:
//
// - us-east-1 imports cleanly.
// - us-west-2 hits a 503 and succeeds on the retry.
// - eu-west-1 runs out of memory, then succeeds on the larger machine it's retried on.
// - eu-central-1 runs out of memory on the larger machine too, so the run crashes.
// - ap-south-1 throws the same error on every attempt until it's out of retries.
// - sa-east-1 downloads its export in shards, one of which needs a retry.
// - compute-recommendations is CPU bound: it blocks the event loop, stops sending heartbeats and
//   is failed as stalled.
// - aggregate-metrics is CPU bound too, and runs past its maxDuration.
//
// The run page shows each failure the way the platform reports it today: the error on the
// failed attempt and on the run. The CPU and memory each attempt used isn't shown anywhere yet,
// but it's in the data (`metrics` on attempts) for designs that want it.

const date = "2026-10-06";

function stackTrace(name: string, message: string, frames: string[]) {
  return [`${name}: ${message}`, ...frames.map((frame) => `    at ${frame}`)].join("\n");
}

function thrownError(
  name: string,
  message: string,
  frames: string[],
  causes?: TaskRunErrorCause[]
): TaskRunError {
  return {
    type: "BUILT_IN_ERROR",
    name,
    message,
    stackTrace: stackTrace(name, message, frames),
    causes,
  };
}

const upstreamUnavailable = thrownError(
  "Error",
  "Upstream responded with 503 Service Unavailable",
  [
    "downloadExport (file:///src/trigger/import-region.ts:74:11)",
    "process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
    "async run (file:///src/trigger/import-region.ts:31:20)",
  ]
);

const unparseableRow = thrownError(
  "Error",
  "Failed to parse export row 18,442",
  [
    "parseExport (file:///src/trigger/import-region.ts:96:13)",
    "async run (file:///src/trigger/import-region.ts:34:18)",
  ],
  [
    {
      name: "TypeError",
      message: "Cannot read properties of undefined (reading 'currency')",
      stackTrace: stackTrace(
        "TypeError",
        "Cannot read properties of undefined (reading 'currency')",
        [
          "normalizeRow (file:///src/trigger/import-region.ts:118:41)",
          "Array.map (<anonymous>)",
          "parseExport (file:///src/trigger/import-region.ts:92:27)",
        ]
      ),
    },
  ]
);

const connectionReset = thrownError("Error", "read ECONNRESET", [
  "TLSWrap.onStreamRead (node:internal/stream_base_commons:216:20)",
]);

// V8 aborts when the heap hits its limit; the platform reports it as out of memory.
const heapOutOfMemory: TaskRunError = {
  type: "INTERNAL_ERROR",
  code: "TASK_PROCESS_OOM_KILLED",
  message: "Process exited with code -1 after signal SIGABRT.",
  stackTrace: [
    "<--- Last few GCs --->",
    "",
    "[7:0x5f6c2a0]    38211 ms: Mark-Compact (reduce) 1010.2 (1035.9) -> 1009.7 (1036.4) MB, pooled: 0 MB, 1301.52 / 0.00 ms  (average mu = 0.134, current mu = 0.012) allocation failure; scavenge might not succeed",
    "",
    "<--- JS stacktrace --->",
    "",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "----- Native stack trace -----",
    "",
    " 1: 0xb7f3f1 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]",
    " 2: 0xef0a60 v8::Utils::ReportOOMFailure(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]",
    " 3: 0xef0d47 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]",
    " 4: 0x1102585  [node]",
    " 5: 0x1102b14 v8::internal::Heap::RecomputeLimits(v8::internal::GarbageCollector) [node]",
  ].join("\n"),
};

// The container went over its memory limit and was killed by the kernel.
const containerOutOfMemory: TaskRunError = {
  type: "INTERNAL_ERROR",
  code: "TASK_PROCESS_OOM_KILLED",
  message: "Process exited with code 137 after signal SIGKILL.",
};

// No heartbeat for five minutes because CPU-heavy work blocked the event loop.
const stalled: TaskRunError = {
  type: "INTERNAL_ERROR",
  code: "TASK_RUN_STALLED_EXECUTING",
  message:
    "Run timed out after 5m due to missing heartbeats (sent every 30s). This typically happens when CPU-heavy work blocks the main thread.",
};

const maxDurationExceeded: TaskRunError = {
  type: "INTERNAL_ERROR",
  code: "MAX_DURATION_EXCEEDED",
  message: "Run exceeded maximum compute time (maxDuration) of 120 seconds",
};

const syncFailed = thrownError("Error", "4 of 8 sync jobs failed", [
  "run (file:///src/trigger/nightly-warehouse-sync.ts:58:11)",
  "process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
]);

function exportUrl(region: string) {
  return `s3://acme-warehouse-exports/${date}/${region}.parquet`;
}

function importRegion(
  region: string,
  options: Omit<RunOptions, "payload" | "tags" | "idempotencyKey">
) {
  return run("import-region", {
    machine: "small-2x",
    payload: { region, date, exportUrl: exportUrl(region) },
    tags: ["nightly-sync", region],
    idempotencyKey: `nightly-sync-${date}-${region}`,
    ...options,
  });
}

/** An import that gets all the way through. */
function importSteps(
  region: string,
  rows: number,
  durations: { download: number; parse: number; load: number }
) {
  return [
    log.info(`Importing ${region}`, { region, rows }),
    span("download-export", {
      duration: durations.download,
      properties: { url: exportUrl(region) },
    }),
    span("parse-export", { duration: durations.parse, properties: { rows } }),
    span("load-into-warehouse", {
      duration: durations.load,
      properties: { table: "orders", rows },
    }),
    log.info(`Imported ${rows.toLocaleString("en-US")} rows`, { region, rows }),
  ];
}

function shard(index: number, download: number, options: { failFirstAttempt?: boolean } = {}) {
  const url = `https://acme-warehouse-exports.s3.sa-east-1.amazonaws.com/${date}/sa-east-1/part-${index}.parquet`;
  const downloaded = [
    httpRequest("GET", url, { duration: download }),
    log.info(`Downloaded shard ${index} of 3`, {
      shard: index,
      bytes: 41_800_000 + index * 812_345,
    }),
  ];

  return run("download-shard", {
    queuedFor: 68,
    payload: { region: "sa-east-1", shard: index, of: 3 },
    output: { shard: index, path: `/tmp/sa-east-1/part-${index}.parquet` },
    tags: ["nightly-sync", "sa-east-1"],
    attempts: options.failFirstAttempt
      ? [
          attempt(
            "cold",
            [runFunction([httpRequest("GET", url, { duration: 1310, isError: true })])],
            { error: connectionReset }
          ),
          attempt("warm", [runFunction(downloaded)], { delay: 1000 }),
        ]
      : [attempt("cold", [runFunction(downloaded)])],
  });
}

export const lotsOfErrors = buildRunPageScenario({
  seed: 3,
  triggeredAt: new Date("2026-10-06T02:00:01.067Z"),
  run: run("nightly-warehouse-sync", {
    queuedFor: 208,
    maxAttempts: 1,
    payload: {
      date,
      regions: ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-south-1", "sa-east-1"],
    },
    error: syncFailed,
    tags: ["nightly-sync"],
    metadata: { date, jobsSucceeded: 4, jobsFailed: 4 },
    attempts: [
      attempt(
        "cold",
        [
          runFunction([
            log.info("Starting nightly sync", { date, regions: 6, jobs: 8 }),
            batchTriggerAndWaitTasks([
              importRegion("us-east-1", {
                output: { region: "us-east-1", rows: 182_340 },
                attempts: [
                  attempt("cold", [
                    runFunction(
                      importSteps("us-east-1", 182_340, { download: 1920, parse: 2410, load: 3120 })
                    ),
                  ]),
                ],
              }),
              importRegion("us-west-2", {
                output: { region: "us-west-2", rows: 96_118 },
                attempts: [
                  attempt(
                    "cold",
                    [
                      runFunction([
                        log.info("Importing us-west-2", { region: "us-west-2", rows: 96_118 }),
                        span("download-export", {
                          duration: 412,
                          isError: true,
                          properties: { url: exportUrl("us-west-2"), status: 503 },
                        }),
                      ]),
                    ],
                    { error: upstreamUnavailable }
                  ),
                  attempt(
                    "warm",
                    [
                      runFunction(
                        importSteps("us-west-2", 96_118, {
                          download: 1340,
                          parse: 1280,
                          load: 1960,
                        })
                      ),
                    ],
                    { delay: 2000 }
                  ),
                ],
              }),
              importRegion("eu-west-1", {
                output: { region: "eu-west-1", rows: 4_210_552 },
                attempts: [
                  attempt(
                    "cold",
                    [
                      runFunction([
                        log.info("Importing eu-west-1", { region: "eu-west-1", rows: 4_210_552 }),
                        span("download-export", {
                          duration: 6120,
                          properties: { url: exportUrl("eu-west-1") },
                        }),
                        span("parse-export", {
                          duration: 32_310,
                          isError: true,
                          properties: { rows: 4_210_552 },
                        }),
                      ]),
                    ],
                    { error: heapOutOfMemory, load: "memory-climb" }
                  ),
                  attempt(
                    "cold",
                    [
                      runFunction(
                        importSteps("eu-west-1", 4_210_552, {
                          download: 5870,
                          parse: 18_940,
                          load: 9210,
                        })
                      ),
                    ],
                    { machine: "large-1x" }
                  ),
                ],
              }),
              importRegion("eu-central-1", {
                error: containerOutOfMemory,
                attempts: [
                  attempt(
                    "cold",
                    [
                      runFunction([
                        log.info("Importing eu-central-1", {
                          region: "eu-central-1",
                          rows: 11_806_204,
                        }),
                        span("download-export", {
                          duration: 9480,
                          properties: { url: exportUrl("eu-central-1") },
                        }),
                        span("parse-export", {
                          duration: 31_150,
                          isError: true,
                          properties: { rows: 11_806_204 },
                        }),
                      ]),
                    ],
                    { error: heapOutOfMemory, load: "memory-climb" }
                  ),
                  attempt(
                    "cold",
                    [
                      runFunction([
                        log.info("Importing eu-central-1", {
                          region: "eu-central-1",
                          rows: 11_806_204,
                        }),
                        span("download-export", {
                          duration: 8960,
                          properties: { url: exportUrl("eu-central-1") },
                        }),
                        span("parse-export", {
                          duration: 65_420,
                          isError: true,
                          properties: { rows: 11_806_204 },
                        }),
                      ]),
                    ],
                    { machine: "large-1x", error: containerOutOfMemory, load: "memory-climb" }
                  ),
                ],
              }),
              importRegion("ap-south-1", {
                error: unparseableRow,
                attempts: [0, 1, 2].map((retry) =>
                  attempt(
                    retry === 0 ? "cold" : "warm",
                    [
                      runFunction([
                        log.info("Importing ap-south-1", { region: "ap-south-1", rows: 51_207 }),
                        span("download-export", {
                          duration: 1120 - retry * 90,
                          properties: { url: exportUrl("ap-south-1") },
                        }),
                        span("parse-export", {
                          duration: 860,
                          isError: true,
                          properties: { rows: 51_207 },
                        }),
                      ]),
                    ],
                    {
                      error: unparseableRow,
                      delay: retry === 0 ? undefined : 1000 * 2 ** (retry - 1),
                    }
                  )
                ),
              }),
              importRegion("sa-east-1", {
                output: { region: "sa-east-1", rows: 64_904, shards: 3 },
                attempts: [
                  attempt("cold", [
                    runFunction([
                      log.info("Importing sa-east-1 in 3 shards", {
                        region: "sa-east-1",
                        shards: 3,
                      }),
                      batchTriggerAndWait("download-shard", [
                        shard(1, 2310),
                        shard(2, 2480, { failFirstAttempt: true }),
                        shard(3, 1980),
                      ]),
                      span("load-into-warehouse", {
                        duration: 2860,
                        properties: { table: "orders", rows: 64_904 },
                      }),
                      log.info("Imported 64,904 rows", { region: "sa-east-1", rows: 64_904 }),
                    ]),
                  ]),
                ],
              }),
              run("compute-recommendations", {
                maxAttempts: 1,
                payload: { date, model: "co-purchase-v3", products: 1920 },
                error: stalled,
                tags: ["nightly-sync"],
                attempts: [
                  attempt(
                    "cold",
                    [
                      runFunction([
                        log.info("Scoring 2,480,000 product pairs", { pairs: 2_480_000 }),
                        span("score-product-pairs", {
                          duration: 304_160,
                          isError: true,
                          properties: { pairs: 2_480_000, similarity: "jaccard" },
                        }),
                      ]),
                    ],
                    { error: stalled, load: "cpu-bound" }
                  ),
                ],
              }),
              run("aggregate-metrics", {
                maxDurationInSeconds: 120,
                payload: { date, events: 18_200_000 },
                error: maxDurationExceeded,
                tags: ["nightly-sync"],
                attempts: [
                  attempt(
                    "cold",
                    [
                      runFunction([
                        log.info("Rolling up 18.2M events into daily metrics", {
                          events: 18_200_000,
                        }),
                        span("rollup-events", {
                          duration: 119_930,
                          isError: true,
                          properties: { events: 18_200_000, granularity: "1d" },
                        }),
                      ]),
                    ],
                    { duration: 120_000, error: maxDurationExceeded, load: "cpu-bound" }
                  ),
                ],
              }),
            ]),
            log.warn("4 of 8 sync jobs failed", {
              failed: [
                "eu-central-1",
                "ap-south-1",
                "compute-recommendations",
                "aggregate-metrics",
              ],
            }),
            triggerAndWait(
              run("send-sync-report", {
                queuedFor: 61,
                payload: { date, succeeded: 4, failed: 4 },
                output: { channel: "#data-alerts", ts: "1791338712.004219" },
                attempts: [
                  attempt("warm", [
                    runFunction([
                      httpRequest("POST", "https://slack.com/api/chat.postMessage", {
                        duration: 284,
                      }),
                      log.info("Posted the sync report to #data-alerts", {
                        channel: "#data-alerts",
                      }),
                    ]),
                  ]),
                ],
              })
            ),
            log.error("Nightly sync finished with failures", { succeeded: 4, failed: 4 }),
          ]),
        ],
        { error: syncFailed }
      ),
    ],
  }),
});
