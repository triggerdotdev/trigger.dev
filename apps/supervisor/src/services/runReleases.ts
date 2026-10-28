import type { V1Pod } from "@kubernetes/client-node";
import type { DequeuedMessage } from "@trigger.dev/core/v3";
import type { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import type { Registry } from "prom-client";
import { Counter } from "prom-client";
import { getRunnerId } from "../util.js";

/** A run at the snapshot it was dequeued with, which a release gives back. */
export type DequeuedRun = {
  runnerId: string;
  runFriendlyId: string;
  snapshotFriendlyId: string;
  environmentId: string;
  deploymentFriendlyId?: string;
};

type ReleaseReason = "PodFailed" | "CreateFailed";

export function runOfPod(pod: V1Pod): DequeuedRun | undefined {
  const container = pod.spec?.containers?.find((c) => c.name === "run-controller");
  const env = (name: string) => container?.env?.find((e) => e.name === name)?.value;
  const runnerId = pod.metadata?.name;
  const runFriendlyId = env("TRIGGER_RUN_ID");
  const snapshotFriendlyId = env("TRIGGER_SNAPSHOT_ID");
  const environmentId = env("TRIGGER_ENV_ID");
  if (!runnerId || !runFriendlyId || !snapshotFriendlyId || !environmentId) {
    return undefined;
  }
  return {
    runnerId,
    runFriendlyId,
    snapshotFriendlyId,
    environmentId,
    deploymentFriendlyId: env("TRIGGER_DEPLOYMENT_FRIENDLY_ID"),
  };
}

export function dequeuedRun(message: DequeuedMessage): DequeuedRun {
  return {
    runnerId: getRunnerId(message.run.friendlyId, message.run.attemptNumber),
    runFriendlyId: message.run.friendlyId,
    snapshotFriendlyId: message.snapshot.friendlyId,
    environmentId: message.environment.id,
    deploymentFriendlyId: message.deployment.friendlyId,
  };
}

type RunReleaseResult = "released" | "dropped" | "conflict" | "unavailable" | "error" | "withheld";

const MINUTE_MS = 60_000;

/**
 * Releases a run whose workload could not be created, or whose pod failed before the run started,
 * so it is requeued at once instead of waiting out the stall timeout. Past `runsReleasedAMinute`
 * different runs released within a minute the rest are withheld. A run takes its place in the
 * window before the call and gives it back unless the platform released it.
 */
export class RunReleaser {
  private readonly logger = new SimpleStructuredLogger("run-releaser");
  private readonly releasesTotal: Counter;
  private releasedAt = new Map<string, number>();
  private inFlight = new Map<string, number>();

  constructor(
    private readonly opts: {
      /** Read on each release, since the worker session is created after the releaser. */
      client: () => Pick<SupervisorHttpClient, "releaseRun">;
      register: Registry;
      runsReleasedAMinute: number;
    }
  ) {
    this.releasesTotal = new Counter({
      name: "supervisor_run_releases_total",
      help: "Runs given back to the platform before they started, by reason (PodFailed or CreateFailed) and result: released, dropped when the run could not be requeued and failed, conflict when the run had moved on, unavailable when the platform has no release, error, or withheld past the minute's limit of different runs",
      labelNames: ["reason", "result"],
      registers: [opts.register],
    });
  }

  async release(run: DequeuedRun, reason: ReleaseReason): Promise<RunReleaseResult> {
    const result = await this.#release(run, reason);
    this.releasesTotal.inc({ reason, result });
    return result;
  }

  async #release(run: DequeuedRun, reason: ReleaseReason): Promise<RunReleaseResult> {
    const fields = { ...run, reason };
    const counted = this.#runsInTheWindow();
    if (counted >= this.opts.runsReleasedAMinute) {
      this.logger.warn(
        "Run not released, the limit of different runs released a minute is reached",
        { ...fields, counted, limit: this.opts.runsReleasedAMinute }
      );
      return "withheld";
    }
    this.inFlight.set(run.runFriendlyId, (this.inFlight.get(run.runFriendlyId) ?? 0) + 1);
    try {
      const result = await this.#callPlatform(run, reason);
      if (result === "released" || result === "dropped") {
        this.releasedAt.set(run.runFriendlyId, Date.now());
      }
      return result;
    } finally {
      this.#leave(run.runFriendlyId);
    }
  }

  #leave(runFriendlyId: string) {
    const left = this.inFlight.get(runFriendlyId)! - 1;
    if (left === 0) {
      this.inFlight.delete(runFriendlyId);
    } else {
      this.inFlight.set(runFriendlyId, left);
    }
  }

  async #callPlatform(run: DequeuedRun, reason: ReleaseReason): Promise<RunReleaseResult> {
    const fields = { ...run, reason };
    try {
      const released = await this.opts
        .client()
        .releaseRun(
          run.runFriendlyId,
          run.snapshotFriendlyId,
          { reason },
          run.runnerId,
          run.environmentId
        );

      if (released.success) {
        if (released.data.requeued) {
          this.logger.info("Released a run that did not start", fields);
          return "released";
        }
        this.logger.warn(
          "Released a run that did not start, it could not be requeued and failed",
          fields
        );
        return "dropped";
      }
      // A webapp that predates the release route answers 404.
      if (released.statusCode === 404) {
        this.logger.debug("Run not released, the platform has no release", fields);
        return "unavailable";
      }
      if (released.statusCode === 409) {
        this.logger.debug("Run not released, it had moved on", fields);
        return "conflict";
      }
      this.logger.warn("Releasing a run that did not start failed", {
        ...fields,
        error: released.error,
        statusCode: released.statusCode,
      });
      return "error";
    } catch (error) {
      this.logger.warn("Releasing a run that did not start failed", { ...fields, error });
      return "error";
    }
  }

  /** Different runs released within the minute or with a release in flight. */
  #runsInTheWindow(): number {
    const now = Date.now();
    for (const [run, at] of this.releasedAt) {
      if (now - at >= MINUTE_MS) {
        this.releasedAt.delete(run);
      }
    }
    let counted = this.releasedAt.size;
    for (const run of this.inFlight.keys()) {
      if (!this.releasedAt.has(run)) {
        counted++;
      }
    }
    return counted;
  }
}
