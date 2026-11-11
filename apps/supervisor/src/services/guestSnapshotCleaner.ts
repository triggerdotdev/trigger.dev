import { readFile } from "node:fs/promises";
import pLimit from "p-limit";
import { IntervalService } from "@trigger.dev/core/v3";
import type { RunExecutionData } from "@trigger.dev/core/v3";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import type { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import type { Registry } from "prom-client";
import { Counter } from "prom-client";
import { z } from "zod";
import { parseCheckpointLocation } from "../workloadManager/runCrd.js";

const RUN_LABEL = "trigger.dev/run";

const NODE_PROXY_TIMEOUT_MS = 10_000;

/** fcrun lists 1,000 by default, sorted by id, so a retained prefix would hide everything after it. */
const LIST_LIMIT = 50_000;

const SnapshotList = z.object({
  snapshots: z.array(
    z.object({
      snapshot_id: z.string(),
      created_at: z.string(),
      labels: z.record(z.string(), z.string()).nullish(),
    })
  ),
  truncated: z.boolean().optional(),
});
type SnapshotList = z.infer<typeof SnapshotList>;
export type GuestSnapshot = SnapshotList["snapshots"][number];

/** A run's latest execution data, or undefined when it could not be read. */
type LatestExecution = RunExecutionData | undefined;

type SnapshotDecision =
  | { action: "delete"; reason: "finished" | "superseded" }
  | { action: "keep"; reason: "alive" | "lookup_error" | "unexpected" };

/**
 * Old enough labelled snapshots, by the run they were taken of. Everything else, templates and
 * boot snapshots among them, is left alone.
 */
export function snapshotsByRun(
  snapshots: GuestSnapshot[],
  now: number,
  minAgeMs: number
): Map<string, string[]> {
  const byRun = new Map<string, string[]>();
  for (const snapshot of snapshots) {
    const runId = snapshot.labels?.[RUN_LABEL];
    const createdAt = Date.parse(snapshot.created_at);
    if (!runId || !snapshot.snapshot_id || Number.isNaN(createdAt)) {
      continue;
    }
    if (now - createdAt < minAgeMs) {
      continue;
    }
    const ids = byRun.get(runId) ?? [];
    ids.push(snapshot.snapshot_id);
    byRun.set(runId, ids);
  }
  return byRun;
}

/**
 * Whether a run's snapshot can go. Only a finished run, or a run whose latest checkpoint is
 * another snapshot, lets it go: the engine restores nothing but the latest checkpoint.
 */
export function decideSnapshot(snapshotId: string, latest: LatestExecution): SnapshotDecision {
  if (!latest) {
    return { action: "keep", reason: "lookup_error" };
  }
  if (latest.snapshot.executionStatus === "FINISHED") {
    return { action: "delete", reason: "finished" };
  }
  const checkpoint = latest.checkpoint;
  if (!checkpoint) {
    return { action: "keep", reason: "alive" };
  }
  if (checkpoint.type !== "COMPUTE") {
    return { action: "keep", reason: "unexpected" };
  }
  let checkpointSnapshotId: string;
  try {
    checkpointSnapshotId = parseCheckpointLocation(checkpoint.location).snapshotID;
  } catch {
    return { action: "keep", reason: "unexpected" };
  }
  if (checkpointSnapshotId !== snapshotId) {
    return { action: "delete", reason: "superseded" };
  }
  return { action: "keep", reason: "alive" };
}

type CleanerResult =
  | "deleted"
  | "held"
  | "not_found"
  | "error"
  | "kept_alive"
  | "kept_lookup_error"
  | "kept_unexpected"
  | "list_error"
  | "token_error";

type GuestSnapshotCleanerOptions = {
  /** This node's node proxy, e.g. http://<host ip>:8083. */
  nodeProxyUrl: string;
  /** A projected service account token, read on every pass since it rotates. */
  tokenPath: string;
  minAgeMs: number;
  intervalMs: number;
  /** Read on each pass, since the worker session is created after the cleaner. */
  client: () => Pick<SupervisorHttpClient, "getLatestSnapshot">;
  register: Registry;
  lookupConcurrency?: number;
};

/**
 * Deletes this node's suspend snapshots that no run can restore from any more, failing closed:
 * anything it cannot account for stays.
 */
export class GuestSnapshotCleaner {
  private readonly logger = new SimpleStructuredLogger("guest-snapshot-cleaner");
  private readonly nodeProxyUrl: string;
  private readonly results: Counter;
  private readonly interval: IntervalService;
  private readonly limit: ReturnType<typeof pLimit>;

  constructor(private readonly opts: GuestSnapshotCleanerOptions) {
    this.nodeProxyUrl = opts.nodeProxyUrl.replace(/\/$/, "");
    this.limit = pLimit(opts.lookupConcurrency ?? 5);
    this.results = new Counter({
      name: "guest_snapshot_cleaner_results_total",
      help: "Guest suspend snapshots the cleaner looked at, by result: deleted, held by a running guest, not_found, error, kept_alive, kept_lookup_error or kept_unexpected; and passes that deleted nothing, by list_error or token_error",
      labelNames: ["result"],
      registers: [opts.register],
    });
    this.interval = new IntervalService({
      intervalMs: opts.intervalMs,
      onInterval: async () => {
        await this.runPass();
      },
    });
  }

  start() {
    this.interval.start();
  }

  stop() {
    this.interval.stop();
  }

  async runPass(): Promise<Partial<Record<CleanerResult, number>>> {
    const summary: Partial<Record<CleanerResult, number>> = {};
    const count = (result: CleanerResult) => {
      this.results.inc({ result });
      summary[result] = (summary[result] ?? 0) + 1;
    };

    let token: string;
    try {
      token = (await readFile(this.opts.tokenPath, "utf8")).trim();
      if (!token) {
        throw new Error("the token file is empty");
      }
    } catch (error) {
      count("token_error");
      this.logger.error("Guest snapshot cleaner pass", { summary, error: messageOf(error) });
      return summary;
    }

    let listed: SnapshotList;
    try {
      listed = await this.listSnapshots(token);
    } catch (error) {
      count("list_error");
      this.logger.error("Guest snapshot cleaner pass", { summary, error: messageOf(error) });
      return summary;
    }

    const byRun = snapshotsByRun(listed.snapshots, Date.now(), this.opts.minAgeMs);
    await Promise.all(
      [...byRun].map(([runId, snapshotIds]) =>
        this.limit(async () => {
          const latest = await this.latestExecution(runId);
          for (const snapshotId of snapshotIds) {
            const decision = decideSnapshot(snapshotId, latest);
            if (decision.action === "keep") {
              count(`kept_${decision.reason}`);
              continue;
            }
            count(await this.deleteSnapshot(token, snapshotId, runId, decision.reason));
          }
        })
      )
    );

    this.logger.log("Guest snapshot cleaner pass", {
      summary,
      listed: listed.snapshots.length,
      truncated: listed.truncated ?? false,
      runs: byRun.size,
    });
    return summary;
  }

  private async listSnapshots(token: string): Promise<SnapshotList> {
    const response = await fetch(`${this.nodeProxyUrl}/snapshots?limit=${LIST_LIMIT}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(NODE_PROXY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`node proxy answered ${response.status}: ${await response.text()}`);
    }
    return SnapshotList.parse(await response.json());
  }

  private async latestExecution(runId: string): Promise<LatestExecution> {
    try {
      const result = await this.opts.client().getLatestSnapshot(runId);
      if (result.success) {
        return result.data.execution;
      }
      this.logger.warn("Run lookup failed, keeping its snapshots", {
        runId,
        statusCode: result.statusCode,
        error: result.error,
      });
    } catch (error) {
      this.logger.warn("Run lookup failed, keeping its snapshots", {
        runId,
        error: messageOf(error),
      });
    }
    return undefined;
  }

  private async deleteSnapshot(
    token: string,
    snapshotId: string,
    runId: string,
    reason: string
  ): Promise<CleanerResult> {
    try {
      const response = await fetch(
        `${this.nodeProxyUrl}/snapshots/${encodeURIComponent(snapshotId)}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(NODE_PROXY_TIMEOUT_MS),
        }
      );
      if (response.ok) {
        this.logger.log("Deleted guest snapshot", { snapshotId, runId, reason });
        return "deleted";
      }
      if (response.status === 404) {
        return "not_found";
      }
      if (response.status === 409) {
        return "held";
      }
      this.logger.error("Guest snapshot delete failed", {
        snapshotId,
        runId,
        status: response.status,
        body: await response.text(),
      });
      return "error";
    } catch (error) {
      this.logger.error("Guest snapshot delete failed", {
        snapshotId,
        runId,
        error: messageOf(error),
      });
      return "error";
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
