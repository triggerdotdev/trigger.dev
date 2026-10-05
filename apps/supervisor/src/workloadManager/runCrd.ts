import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PatchStrategy,
  type Informer,
  type KubernetesListObject,
  type KubernetesObject,
  type ObjectCache,
} from "@kubernetes/client-node";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import type {
  CheckpointType,
  EnvironmentType,
  MachinePreset,
  SnapshotRouteWire,
} from "@trigger.dev/core/v3";
import { type K8sApi, createK8sApi } from "../clients/kubernetes.js";
import { ReconnectingInformer } from "../clients/reconnectingInformer.js";
import { getRestoreRunnerId, getRunnerId } from "../util.js";
import type {
  PublishedSuspend,
  RunnerSnapshotter,
  RunnerSuspendRequest,
  RunnerSuspendRequested,
  RunnerSuspendResult,
} from "../services/computeSnapshotService.js";
import type {
  WorkloadManager,
  WorkloadManagerCreateOptions,
  WorkloadManagerOptions,
} from "./types.js";

const GROUP = "compute.trigger.dev";
const VERSION = "v1alpha1";
const PLURAL = "runners";

/** Set on a Runner to ask the operator to snapshot its guest; the value names the request. */
export const SUSPEND_ANNOTATION = "compute.trigger.dev/suspend";

/** The run a suspend request is for, so a restarted supervisor can deliver its outcome. */
export const SUSPEND_RUN_ANNOTATION = "compute.trigger.dev/suspend-run";

/** The suspend request whose outcome the platform has accepted. */
export const SUSPEND_SUBMITTED_ANNOTATION = "compute.trigger.dev/suspend-submitted";

/** Set on every restore Runner, so an informer can cache restores only. */
export const RESTORE_LABEL = "compute.trigger.dev/restore";

const RESTORE_SELECTOR = `${RESTORE_LABEL}=true`;

/** Read errors that the next poll would only repeat. */
const TERMINAL_READ_CODES = new Set([400, 401, 403, 422]);

const MAX_POLL_BACKOFF_MS = 60_000;

/** The key inside a deployment's token Secret. */
const TOKEN_KEY = "token";

type OwnerReference = { apiVersion: string; kind: string; name: string; uid: string };

/** The isolation lane a Runner asks for, which is the CRD's own enum. */
export type RunnerRuntime = "container" | "microvm";

export type RunCrdWorkloadManagerOptions = WorkloadManagerOptions & {
  /** Passed in, not read from env, so the translation below is testable alone. */
  namespace: string;
  /**
   * Cell-wide: a cell's node pools decide what it can serve, and nothing on a
   * dequeued message can express a per-run choice. The operator fails a microvm
   * Runner on a cell with no RuntimeClass rather than serve it with weaker isolation.
   */
  runtime: RunnerRuntime;
  /** Suspends go to the operator only under microvm, where there is a guest to snapshot. */
  snapshots?: { enabled: boolean; delayMs: number; dispatchLimit: number };
  /** How often a suspend's or a polled resume's outcome is read back off the Runner. */
  suspendPollMs?: number;
  /**
   * How long the operator has to take a suspend up, and then to answer it. Longer
   * than its own snapshot budget, so its failure arrives first and carries the reason.
   */
  suspendTimeoutMs?: number;
  /**
   * How long a resume has to reach Running. Longer than the operator's pod start
   * deadline, so its failure arrives first and carries the reason.
   */
  restoreTimeoutMs?: number;
  /** Follows resumes from one shared watch; without it each resume is polled. */
  restoreInformer?: RunnerRestoreInformer;
};

/** `message` is the operator's own, when its Failed condition recorded one. */
export type RunnerRestoreResult =
  | { ok: true }
  | { ok: false; reason: string; error: string; message?: string };

/**
 * A resume's outcome, with when its Runner was created when a phase decided it,
 * and the uid of the Runner it is about when known.
 */
export type RestoreWatchResult = RunnerRestoreResult & { createdAt?: Date; uid?: string };

/** The Runner a resume created, or found in the way and took as its own. */
export type RestoreRunner = { runnerId: string; uid?: string };

export type RunnerPhaseListener = (phase: string | undefined) => void;

/**
 * Creates a Runner and stops; the operator builds the pod, so uid, node selection
 * and labels are decided in one place. A Runner serves every later run warm start
 * hands it, so the run that caused it is only its bootstrap.
 */
export class RunCrdWorkloadManager implements WorkloadManager, RunnerSnapshotter {
  private readonly logger = new SimpleStructuredLogger("run-crd-workload-provider");
  private readonly k8s: K8sApi;
  private readonly namespace: string;
  private readonly runtime: RunnerRuntime;
  private readonly snapshots?: RunCrdWorkloadManagerOptions["snapshots"];
  private readonly suspendPollMs: number;
  private readonly suspendTimeoutMs: number;
  private readonly restoreTimeoutMs: number;
  private readonly restoreInformer?: RunnerRestoreInformer;

  constructor(opts: RunCrdWorkloadManagerOptions) {
    this.k8s = createK8sApi();
    this.namespace = opts.namespace;
    this.runtime = opts.runtime;
    this.snapshots = opts.snapshots;
    this.suspendPollMs = opts.suspendPollMs ?? 5_000;
    this.suspendTimeoutMs = opts.suspendTimeoutMs ?? 6 * 60_000;
    this.restoreTimeoutMs = opts.restoreTimeoutMs ?? 21 * 60_000;
    this.restoreInformer = opts.restoreInformer;
  }

  get snapshotsEnabled(): boolean {
    return this.runtime === "microvm" && !!this.snapshots?.enabled;
  }

  get snapshotDelayMs(): number {
    return this.snapshots?.delayMs ?? 0;
  }

  get snapshotDispatchLimit(): number {
    return this.snapshots?.dispatchLimit ?? 1;
  }

  /**
   * Asks the operator to snapshot the runner's guest by annotating its Runner.
   * The runner id is the Runner's name. It comes from a workload header and the
   * snapshot is submitted as the caller's checkpoint, so with an owner a Runner
   * from another environment or deployment is refused.
   */
  async requestSuspend(opts: RunnerSuspendRequest): Promise<RunnerSuspendRequested> {
    try {
      if (opts.owner) {
        const spec = ((await this.getRunner(opts.runnerId)) as RunnerOwnerSpec | null)?.spec;
        if (
          spec?.owner?.envID !== opts.owner.envId ||
          spec?.deployment?.friendlyID !== opts.owner.deploymentFriendlyId
        ) {
          return { ok: false, error: "the Runner belongs to another deployment" };
        }
      }
      await this.k8s.objects.patch(
        {
          apiVersion: `${GROUP}/${VERSION}`,
          kind: "Runner",
          metadata: {
            name: opts.runnerId,
            namespace: this.namespace,
            annotations: {
              [SUSPEND_ANNOTATION]: opts.snapshotFriendlyId,
              [SUSPEND_RUN_ANNOTATION]: opts.runFriendlyId,
            },
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        PatchStrategy.MergePatch
      );
    } catch (err: unknown) {
      return { ok: false, error: `suspend request failed: ${messageOf(err)}` };
    }
    return { ok: true };
  }

  async publishedSuspendOf(runnerId: string): Promise<PublishedSuspend | undefined> {
    return publishedSuspend(await this.getRunner(runnerId));
  }

  /** Every Runner whose latest suspend has an outcome not yet marked submitted. */
  async publishedSuspends(): Promise<PublishedSuspend[]> {
    const list = (await this.k8s.custom.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.namespace,
      plural: PLURAL,
    })) as { items?: unknown[] } | null;
    return (list?.items ?? []).flatMap((runner) => {
      const published = publishedSuspend(runner);
      return published ? [published] : [];
    });
  }

  async markSuspendSubmitted(opts: { runnerId: string; snapshotFriendlyId: string }) {
    await this.k8s.objects.patch(
      {
        apiVersion: `${GROUP}/${VERSION}`,
        kind: "Runner",
        metadata: {
          name: opts.runnerId,
          namespace: this.namespace,
          annotations: { [SUSPEND_SUBMITTED_ANNOTATION]: opts.snapshotFriendlyId },
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      PatchStrategy.MergePatch
    );
  }

  /**
   * Waits for the operator's answer to a request on the Runner's status. The
   * wait restarts once the operator takes the request up, since its own
   * snapshot budget only starts then and its failure carries the reason.
   */
  async awaitSuspend(opts: {
    runnerId: string;
    snapshotFriendlyId: string;
  }): Promise<RunnerSuspendResult> {
    let takenUp = false;
    let deadline = Date.now() + this.suspendTimeoutMs;
    let overloaded = 0;
    while (Date.now() < deadline) {
      await sleep(pollDelayMs(this.suspendPollMs, overloaded, deadline));
      let runner: unknown;
      try {
        runner = await this.getRunner(opts.runnerId);
        overloaded = 0;
      } catch (err: unknown) {
        const code = statusCodeOf(err);
        if (code === 404) {
          return { ok: false, error: "the Runner no longer exists" };
        }
        if (code !== undefined && TERMINAL_READ_CODES.has(code)) {
          return { ok: false, error: `Runner read failed: ${messageOf(err)}` };
        }
        if (isOverloaded(code)) {
          overloaded++;
        }
        this.logger.warn("[RunCrdWorkloadManager] Runner read failed during suspend", {
          runnerId: opts.runnerId,
          rawError: err,
        });
        continue;
      }
      const outcome = suspendOutcome(runner, opts.snapshotFriendlyId);
      if (outcome) {
        return outcome;
      }
      const answering = (runner as RunnerSuspendStatus | null)?.status?.suspend?.request;
      // The operator took up a later request after answering ours between polls,
      // so our answer is gone and waiting longer cannot bring it back.
      if (takenUp && answering && answering !== opts.snapshotFriendlyId) {
        return { ok: false, error: "displaced by a later suspend request" };
      }
      if (!takenUp && answering === opts.snapshotFriendlyId) {
        takenUp = true;
        deadline = Date.now() + this.suspendTimeoutMs;
      }
    }
    return {
      ok: false,
      error: takenUp
        ? `no suspend outcome within ${this.suspendTimeoutMs}ms of the operator taking it up`
        : `the operator did not take up the suspend within ${this.suspendTimeoutMs}ms; is a suspend-capable operator running?`,
    };
  }

  /**
   * Waits for a resume to start or to fail. Nothing else watches one: a resume
   * that fails never has a runner to connect and say so.
   */
  async awaitRestore(
    { runnerId, uid }: RestoreRunner,
    onPhase?: RunnerPhaseListener,
    signal?: AbortSignal
  ): Promise<RestoreWatchResult> {
    const result = this.restoreInformer
      ? await this.restoreInformer.awaitRestore(runnerId, {
          uid,
          timeoutMs: this.restoreTimeoutMs,
          onPhase,
          signal,
        })
      : await awaitRestoreOf(() => this.getRunner(runnerId), {
          uid,
          pollMs: this.suspendPollMs,
          timeoutMs: this.restoreTimeoutMs,
          onPhase,
          signal,
          onReadError: (err) =>
            this.logger.warn("[RunCrdWorkloadManager] Runner read failed during restore", {
              runnerId,
              rawError: err,
            }),
        });
    if (result.ok || result.reason !== "Timeout" || signal?.aborted) {
      return result;
    }
    return this.recheckTimedOutRestore(runnerId, result);
  }

  /**
   * A watch that timed out may only have missed the Runner's start, so the Runner
   * itself decides. One still starting, replaced or unreadable stays a timeout.
   */
  private async recheckTimedOutRestore(
    runnerId: string,
    timedOut: RestoreWatchResult & { ok: false }
  ): Promise<RestoreWatchResult> {
    let runner: unknown;
    try {
      runner = await this.getRunner(runnerId);
    } catch (err: unknown) {
      this.logger.warn("[RunCrdWorkloadManager] Runner read failed after a restore timeout", {
        runnerId,
        rawError: err,
      });
      return timedOut;
    }
    if (!isRunner(runner, timedOut.uid)) {
      return timedOut;
    }
    const outcome = restoreOutcome(runner);
    return outcome ? { ...outcome, createdAt: createdAtOf(runner), uid: uidOf(runner) } : timedOut;
  }

  /**
   * Deletes a failed resume so its redelivery can create it again. Preconditioned
   * on uid, so a Runner that already replaced it is left alone; one already gone is fine.
   */
  async deleteRestoreRunner(runnerId: string, uid: string): Promise<void> {
    try {
      await this.k8s.custom.deleteNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: this.namespace,
        plural: PLURAL,
        name: runnerId,
        body: { preconditions: { uid } },
      });
    } catch (err: unknown) {
      if (statusCodeOf(err) !== 404) {
        throw err;
      }
    }
  }

  private getRunner(name: string): Promise<unknown> {
    return this.k8s.custom.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.namespace,
      plural: PLURAL,
      name,
    });
  }

  /**
   * Only the microvm lane's node runtime can restore, and only a snapshot it
   * took. Any other checkpoint's location means nothing to it.
   */
  restores(checkpoint: { type: CheckpointType }): boolean {
    return this.runtime === "microvm" && checkpoint.type === "COMPUTE";
  }

  async create(opts: WorkloadManagerCreateOptions) {
    await this.createRunner(opts, getRunnerId(opts.runFriendlyId, opts.nextAttemptNumber));
  }

  /**
   * Creates a resume: a Runner the operator restores from the checkpoint's
   * snapshot, on the node holding it, instead of cold-starting. Named from the
   * checkpoint, so a redelivered restore finds the first Runner and leaves it
   * rather than restoring twice. Returns the Runner, also for a resume found in
   * the way, which a restarted supervisor has no other watch on.
   */
  async restore(
    opts: WorkloadManagerCreateOptions,
    checkpoint: { id: string; location: string }
  ): Promise<RestoreRunner> {
    const runnerId = getRestoreRunnerId(opts.runFriendlyId, checkpoint.id);
    const restore = parseCheckpointLocation(checkpoint.location);
    const created = await this.createRunner(opts, runnerId, restore);
    if (created) {
      return { runnerId, uid: created.uid };
    }
    try {
      const existing = await this.readExistingRestore(runnerId, restore);
      if (!existing.ended) {
        return { runnerId, uid: existing.uid };
      }
      await this.deleteEndedRestore(runnerId, existing.uid);
    } catch (err: unknown) {
      // Deleted between the create and the read, as a requeue deletes a failed resume.
      if (statusCodeOf(err) !== 404) {
        throw err;
      }
    }
    const again = await this.createRunner(opts, runnerId, restore);
    if (again) {
      return { runnerId, uid: again.uid };
    }
    const existing = await this.readExistingRestore(runnerId, restore);
    if (existing.ended) {
      throw new Error(`restore Runner ${runnerId} already ended (${existing.ended})`);
    }
    return { runnerId, uid: existing.uid };
  }

  /**
   * A resume already in the way counts as this restore only while it restores
   * the same snapshot. `ended` is the phase of one held terminal for the
   * operator's TTL, which will never resume the guest.
   */
  private async readExistingRestore(
    runnerId: string,
    restore: RunnerRestore
  ): Promise<{ uid?: string; ended?: string }> {
    const existing = (await this.getRunner(runnerId)) as ExistingRestore | null;
    const phase = existing?.status?.phase;
    const spec = existing?.spec?.restore;
    if (spec?.snapshotID !== restore.snapshotID || spec?.node !== restore.node) {
      throw new Error(
        `restore Runner ${runnerId} restores ${JSON.stringify(spec ?? null)}, not ${checkpointLocation(restore)}`
      );
    }
    this.logger.warn("[RunCrdWorkloadManager] Restore Runner already exists", { runnerId, phase });
    const ended = phase === "Succeeded" || phase === "Failed" ? phase : undefined;
    return { uid: uidOf(existing), ended };
  }

  /**
   * Takes an ended resume out of the way of this delivery. A Succeeded one too: a
   * redelivery means this snapshot is the run's latest again, so its guest exited
   * without continuing the run. A 409 is another delivery having replaced it already.
   */
  private async deleteEndedRestore(runnerId: string, uid: string | undefined) {
    if (!uid) {
      throw new Error(`restore Runner ${runnerId} already ended, with no uid to guard its delete`);
    }
    try {
      await this.deleteRestoreRunner(runnerId, uid);
    } catch (err: unknown) {
      if (statusCodeOf(err) !== 409) {
        throw err;
      }
    }
  }

  /** Returns false when a resume's Runner was already there. */
  private async createRunner(
    opts: WorkloadManagerCreateOptions,
    runnerId: string,
    restore?: RunnerRestore
  ): Promise<{ uid?: string } | false> {
    const token = await this.ensureRunnerToken(opts, runnerId, !!restore);

    const body = runnerBodyFor(opts, {
      name: runnerId,
      namespace: this.namespace,
      runtime: this.runtime,
      token,
      restore,
    });

    this.logger.verbose("[RunCrdWorkloadManager] Creating runner", { runnerId, body });

    let created: unknown;
    try {
      created = await this.k8s.custom.createNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: this.namespace,
        plural: PLURAL,
        body,
        // An unknown field is then a 422 naming it, not a silent prune.
        fieldValidation: "Strict",
      });
    } catch (err: unknown) {
      await this.releaseRunnerToken(token, err);
      // A resume's name carries the checkpoint, so the Runner in the way is this
      // resume, still restoring or held terminal for the operator's TTL. A cold
      // start's carries the attempt, so its 409 is an earlier terminal Runner.
      if (restore && statusCodeOf(err) === 409) {
        return false;
      }
      this.logger.error("[RunCrdWorkloadManager] Create failed", { runnerId, rawError: err });
      throw err;
    }

    const runnerUid = uidOf(created);
    if (token && runnerUid) {
      await this.adoptRunnerToken(token.name, { name: runnerId, uid: runnerUid });
    }
    return { uid: runnerUid };
  }

  /**
   * Makes the Runner own the Secret, so the garbage collector takes it with the
   * Runner. An object that never had an owner is not a dependent, so nothing can
   * collect the Secret before this lands.
   *
   * Never throws: an ownerless Secret holding one expiring token costs less than
   * failing a run that is about to start.
   */
  private async adoptRunnerToken(name: string, runner: { name: string; uid: string }) {
    const ownerReferences: OwnerReference[] = [
      { apiVersion: `${GROUP}/${VERSION}`, kind: "Runner", name: runner.name, uid: runner.uid },
    ];

    try {
      await this.k8s.objects.patch(
        {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name, namespace: this.namespace, ownerReferences },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        PatchStrategy.StrategicMergePatch
      );
    } catch (err: unknown) {
      this.logger.warn("[RunCrdWorkloadManager] Token secret adoption failed", {
        name,
        runner: runner.name,
        rawError: err,
      });
    }
  }

  /**
   * Deletes the Secret a failed create left behind; with no owner coming, the
   * collector would never take it.
   *
   * Only on a 4xx. No status or a 5xx may be a create that committed before its
   * response was lost, and deleting then would fail a Runner that is about to
   * start, so the Secret is kept and logged: an ownerless expiring token is the
   * cheaper mistake. Reading the Runner back would tell the cases apart; not worth it
   * for a path this rare. Only when this call wrote it: a create returns a uid, a 409 does not.
   */
  private async releaseRunnerToken(
    token: { name: string; uid?: string } | undefined,
    err: unknown
  ) {
    if (!token?.uid) {
      return;
    }

    const status = statusCodeOf(err);
    if (status !== undefined && status >= 400 && status < 500) {
      await this.deleteRunnerToken(token.name, token.uid);
      return;
    }

    this.logger.warn("[RunCrdWorkloadManager] Token secret kept after an indeterminate create", {
      name: token.name,
      status,
    });
  }

  /**
   * Preconditioned on uid, so a Secret that is no longer the one this call wrote
   * is left alone. A 409 is that precondition refusing, which is the answer.
   */
  private async deleteRunnerToken(name: string, uid: string) {
    try {
      await this.k8s.core.deleteNamespacedSecret({
        namespace: this.namespace,
        name,
        body: { preconditions: { uid } },
      });
    } catch (err: unknown) {
      const status = statusCodeOf(err);
      if (status === 404 || status === 409) {
        return;
      }
      this.logger.warn("[RunCrdWorkloadManager] Token secret cleanup failed", {
        name,
        rawError: err,
      });
    }
  }

  /**
   * One Secret per runner, not per deployment version: the collector decides a
   * shared Secret's fate from owners it may have read before the newest was added,
   * so a delete it already chose can take the credential from a starting runner.
   *
   * A reference, not the token in the spec, where anything with get on Runners
   * could read it; the kubelet resolves it, so the operator never does.
   *
   * A resume's name is reused when a failed one is deleted and created again, and
   * the collector may not have taken the old Runner's Secret yet. A Secret per
   * create keeps the new Runner from sharing one that is about to be deleted.
   */
  private async ensureRunnerToken(
    opts: WorkloadManagerCreateOptions,
    runnerId: string,
    perCreate: boolean
  ): Promise<{ name: string; key: string; uid?: string } | undefined> {
    if (!opts.deploymentToken) {
      return undefined;
    }

    const name = runnerTokenSecretName(
      runnerId,
      opts.deploymentToken,
      perCreate ? randomUUID() : undefined
    );

    try {
      const created = await this.writeTokenSecret(name, opts.deploymentToken);
      return { name, key: TOKEN_KEY, uid: uidOf(created) };
    } catch (err: unknown) {
      // A redrive: the name carries the token's digest, so the existing Secret holds
      // the same token. No uid, so the failure path cannot delete what it did not create.
      if (statusCodeOf(err) === 409) {
        return { name, key: TOKEN_KEY };
      }
      // Without the reference the runner falls back to the friendly id and
      // fails authentication in a way that reads as a platform problem.
      this.logger.error("[RunCrdWorkloadManager] Runner token secret failed", {
        name,
        rawError: err,
      });
      throw err;
    }
  }

  private async writeTokenSecret(name: string, token: string) {
    return await this.k8s.core.createNamespacedSecret({
      namespace: this.namespace,
      body: {
        metadata: {
          name,
          namespace: this.namespace,
          labels: {
            "app.kubernetes.io/part-of": "trigger-worker",
            "app.kubernetes.io/component": "runner-token",
          },
        },
        type: "Opaque",
        // Spares the kubelet a watch, and says the token does not change.
        immutable: true,
        stringData: { [TOKEN_KEY]: token },
      },
    });
  }
}

type RunnerOwnerSpec = {
  spec?: { owner?: { envID?: string }; deployment?: { friendlyID?: string } };
};

type ExistingRestore = {
  spec?: { restore?: Partial<RunnerRestore> };
  status?: { phase?: string };
};

type RunnerSuspendStatus = {
  status?: {
    phase?: string;
    suspend?: { request?: string; snapshotID?: string; node?: string };
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
};

/**
 * The operator's answer to one suspend request, read off the Runner, or
 * undefined while it is still working on it. A Runner that ends without
 * answering is a failure, since nothing will answer after that.
 */
export function suspendOutcome(runner: unknown, request: string): RunnerSuspendResult | undefined {
  const status = (runner as RunnerSuspendStatus | null)?.status;
  if (status?.suspend?.request === request) {
    const condition = status.conditions?.find((c) => c.type === "Suspended");
    if (condition?.status === "True" && status.suspend.snapshotID && status.suspend.node) {
      return {
        ok: true,
        location: checkpointLocation({
          node: status.suspend.node,
          snapshotID: status.suspend.snapshotID,
        }),
      };
    }
    if (condition?.status === "False") {
      return { ok: false, error: `${condition.reason}: ${condition.message}` };
    }
  }
  if (status?.phase === "Succeeded" || status?.phase === "Failed") {
    return {
      ok: false,
      error: `the Runner ended (${status.phase}) before the suspend was answered`,
    };
  }
  return undefined;
}

/** Polls a resume's Runner, read by `readRunner`, until it starts, fails or times out. */
export async function awaitRestoreOf(
  readRunner: () => Promise<unknown>,
  opts: {
    /** The Runner this resume created; one by the same name with another uid is not it. */
    uid?: string;
    pollMs: number;
    timeoutMs: number;
    onPhase?: RunnerPhaseListener;
    onReadError: (err: unknown) => void;
    /** Ends the wait early, with a result the caller is expected to ignore. */
    signal?: AbortSignal;
  }
): Promise<RestoreWatchResult> {
  const deadline = Date.now() + opts.timeoutMs;
  let overloaded = 0;
  while (Date.now() < deadline) {
    try {
      await sleep(pollDelayMs(opts.pollMs, overloaded, deadline), undefined, {
        signal: opts.signal,
      });
    } catch {
      break;
    }
    let runner: unknown;
    try {
      runner = await readRunner();
      overloaded = 0;
    } catch (err: unknown) {
      const code = statusCodeOf(err);
      if (code === 404) {
        return runnerGone();
      }
      if (code !== undefined && TERMINAL_READ_CODES.has(code)) {
        return { ok: false, reason: "ReadFailed", error: `Runner read failed: ${messageOf(err)}` };
      }
      if (isOverloaded(code)) {
        overloaded++;
      }
      opts.onReadError(err);
      continue;
    }
    if (!isRunner(runner, opts.uid)) {
      continue;
    }
    opts.onPhase?.(phaseOf(runner));
    const outcome = restoreOutcome(runner);
    if (outcome) {
      return { ...outcome, createdAt: createdAtOf(runner), uid: uidOf(runner) };
    }
  }
  return { ...restoreTimedOut(opts.timeoutMs), uid: opts.uid };
}

/**
 * Follows every restore Runner through one list and watch, selected by
 * RESTORE_LABEL, instead of a read per restore per poll. A waiter registered
 * by Runner name is resolved by the events for that name.
 */
export class RunnerRestoreInformer {
  private readonly logger = new SimpleStructuredLogger("runner-restore-informer");
  private readonly namespace: string;
  private readonly onUnwatchedFailure?: (failure: UnwatchedRestoreFailure) => void;
  private readonly onUnwatchedRestore?: (restore: UnwatchedRestore) => void;
  private readonly watch: ReconnectingInformer<KubernetesObject>;
  private readonly informer: Informer<KubernetesObject> & ObjectCache<KubernetesObject>;
  private readonly waiters = new Map<string, RestoreWaiter[]>();
  private listed = false;
  /** Uids from the first list whose add has not been seen yet. */
  private readonly firstListed = new Set<string>();

  constructor(opts: {
    namespace: string;
    reconnectIntervalMs?: number;
    k8s?: K8sApi;
    /**
     * A restore found already failed with nothing here waiting on it, such as
     * one that ended while this process was down, found by the list on start.
     */
    onUnwatchedFailure?: (failure: UnwatchedRestoreFailure) => void;
    /**
     * A restore still starting when the first list found it, whose watch, if
     * any, went with an earlier process.
     */
    onUnwatchedRestore?: (restore: UnwatchedRestore) => void;
  }) {
    const k8s = opts.k8s ?? createK8sApi();
    this.namespace = opts.namespace;
    this.onUnwatchedFailure = opts.onUnwatchedFailure;
    this.onUnwatchedRestore = opts.onUnwatchedRestore;
    this.watch = new ReconnectingInformer({
      name: "runner-restore",
      logger: this.logger,
      reconnectIntervalMs: opts.reconnectIntervalMs ?? 1_000,
      list: () => this.listRestores(k8s),
      makeInformer: (list) =>
        k8s.makeInformer(
          `/apis/${GROUP}/${VERSION}/namespaces/${this.namespace}/${PLURAL}`,
          list,
          RESTORE_SELECTOR
        ),
    });
    this.informer = this.watch.informer;
    this.informer.on("add", (runner) => this.onEvent(runner, "add"));
    this.informer.on("update", (runner) => this.onEvent(runner, "update"));
    this.informer.on("delete", (runner) => this.onEvent(runner, "delete"));
  }

  async start() {
    await this.watch.start();
  }

  async stop() {
    await this.watch.stop();
  }

  /**
   * Resolves when the Runner starts, fails or is deleted, or after `timeoutMs`.
   * An abort resolves it as a timeout.
   */
  awaitRestore(
    runnerId: string,
    opts: { uid?: string; timeoutMs: number; onPhase?: RunnerPhaseListener; signal?: AbortSignal }
  ): Promise<RestoreWatchResult> {
    const existing = this.waiters.get(runnerId)?.find((w) => w.uid === opts.uid);
    if (existing) {
      return existing.promise;
    }
    let resolve!: (result: RestoreWatchResult) => void;
    const promise = new Promise<RestoreWatchResult>((r) => (resolve = r));
    const timedOut = () => finish({ ...restoreTimedOut(opts.timeoutMs), uid: opts.uid });
    const finish = (result: RestoreWatchResult) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", timedOut);
      const rest = (this.waiters.get(runnerId) ?? []).filter((w) => w !== waiter);
      if (rest.length) {
        this.waiters.set(runnerId, rest);
      } else {
        this.waiters.delete(runnerId);
      }
      resolve(result);
    };
    const timer = setTimeout(timedOut, opts.timeoutMs);
    const waiter: RestoreWaiter = {
      uid: opts.uid,
      promise,
      observe: (runner, deleted) => {
        // The cache can still hold the Runner this one replaced, failed and deleted.
        if (!isRunner(runner, opts.uid)) {
          return;
        }
        opts.onPhase?.(phaseOf(runner));
        const outcome = restoreOutcome(runner);
        if (outcome) {
          finish({ ...outcome, createdAt: createdAtOf(runner), uid: uidOf(runner) });
        } else if (deleted) {
          finish(runnerGone());
        }
      },
    };
    this.waiters.set(runnerId, [...(this.waiters.get(runnerId) ?? []), waiter]);
    if (opts.signal?.aborted) {
      timedOut();
      return promise;
    }
    opts.signal?.addEventListener("abort", timedOut, { once: true });
    // The Runner's add can arrive before its create returns and this registers.
    const cached = this.informer.get(runnerId, this.namespace);
    if (cached) {
      waiter.observe(cached, false);
    }
    return promise;
  }

  /** Notes the first list's Runners, so a later add can tell a create from a listed one. */
  private async listRestores(k8s: K8sApi): Promise<KubernetesListObject<KubernetesObject>> {
    const list = (await k8s.custom.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.namespace,
      plural: PLURAL,
      labelSelector: RESTORE_SELECTOR,
    })) as KubernetesListObject<KubernetesObject>;
    if (!this.listed) {
      this.listed = true;
      for (const runner of list.items ?? []) {
        const uid = uidOf(runner);
        if (uid) {
          this.firstListed.add(uid);
        }
      }
    }
    return list;
  }

  private onEvent(runner: KubernetesObject, verb: "add" | "update" | "delete") {
    const name = runner.metadata?.name;
    if (!name) {
      return;
    }
    const uid = uidOf(runner);
    const firstListed = uid !== undefined && this.firstListed.delete(uid);
    const waiters = this.waiters.get(name);
    if (waiters) {
      for (const waiter of waiters) {
        waiter.observe(runner, verb === "delete");
      }
      return;
    }
    if (verb !== "add") {
      return;
    }
    const bootstrap = (runner as RunnerBootstrapSpec).spec?.bootstrap;
    const outcome = restoreOutcome(runner);
    // A Runner first seen already failed comes from a list, not from a create
    // here, so nothing has handled its outcome.
    if (outcome && !outcome.ok) {
      this.onUnwatchedFailure?.({
        runnerId: name,
        runFriendlyId: bootstrap?.runFriendlyID,
        snapshotFriendlyId: bootstrap?.snapshotFriendlyID,
        outcome: { ...outcome, createdAt: createdAtOf(runner), uid },
      });
      return;
    }
    // Only from the first list: a later add is a create, and its creator watches it.
    if (!outcome && firstListed) {
      this.onUnwatchedRestore?.({
        runnerId: name,
        uid,
        runFriendlyId: bootstrap?.runFriendlyID,
        snapshotFriendlyId: bootstrap?.snapshotFriendlyID,
      });
    }
  }
}

type RestoreWaiter = {
  uid?: string;
  promise: Promise<RestoreWatchResult>;
  observe: (runner: unknown, deleted: boolean) => void;
};

export type UnwatchedRestore = {
  runnerId: string;
  uid?: string;
  runFriendlyId?: string;
  snapshotFriendlyId?: string;
};

export type UnwatchedRestoreFailure = {
  runnerId: string;
  runFriendlyId?: string;
  snapshotFriendlyId?: string;
  outcome: RestoreWatchResult & { ok: false };
};

type RunnerBootstrapSpec = {
  spec?: { bootstrap?: { runFriendlyID?: string; snapshotFriendlyID?: string } };
};

/**
 * Heartbeats the dequeued run while the operator brings its resume up, so a
 * slow restore is not taken for a stalled one. Stops once the Runner runs or ends.
 *
 * Starts at once rather than on a first read: every watch begins on a Runner
 * just created or seen still starting, and reads that fail for longer than the
 * platform's stall timeout would otherwise requeue a healthy restore.
 */
export function restoreHeartbeat(beat: () => Promise<void>, intervalMs: number) {
  let timer: NodeJS.Timeout | undefined = setInterval(() => void beat(), intervalMs);
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  return {
    onPhase: (phase: string | undefined) => {
      if (restoreOutcome({ status: { phase } })) {
        stop();
      }
    },
    stop,
  };
}

/** The checkpoint itself cannot be restored, so a retry would only fail the same way. */
const PERMANENT_RESTORE_REASONS = new Set([
  "SnapshotNodeGone",
  "SnapshotNodeUnschedulable",
  "RestoreNotSupported",
  "SnapshotNotFound",
]);

export type RestoreFailureAction =
  | { outcome: "fail" }
  | { outcome: "requeue"; deleteRunner: boolean };

/**
 * What to tell the platform about a failed resume, from the operator's reason
 * or the watch's own. Undefined tells it nothing.
 */
export function classifyRestoreFailure(reason: string): RestoreFailureAction | undefined {
  if (PERMANENT_RESTORE_REASONS.has(reason)) {
    return { outcome: "fail" };
  }
  switch (reason) {
    // The Runner's state is unknown, so the platform's stall timeout decides.
    case "ReadFailed":
      return undefined;
    // Read again after the watch gave up and still starting, or unreadable. The
    // operator's start deadline fails a stuck one, and a redelivery replaces it.
    case "Timeout":
      return undefined;
    // A Runner now under the name is not this one, so there is nothing to delete.
    case "RunnerGone":
      return { outcome: "requeue", deleteRunner: false };
    default:
      return { outcome: "requeue", deleteRunner: true };
  }
}

export type RestoreOutcomeReport = (body: {
  outcome: "requeue" | "fail";
  reason: string;
  message?: string;
  snapshotRoute?: SnapshotRouteWire;
}) => Promise<{ success: true } | { success: false; error: string; statusCode?: number }>;

export type RestoreFailureSettlement =
  | { action: "none" }
  | { action: "kept"; error: string; forbidden?: boolean }
  | {
      action: "reported";
      outcome: "requeue" | "fail";
      result: "ok" | "conflict" | "error";
      error?: string;
      cleanupError?: string;
    };

/**
 * Reports a failed resume to the platform. A requeue first deletes the Runner,
 * since its redelivery would otherwise find it held for the operator's TTL and
 * fail again; when that delete fails nothing is reported. A fail deletes it
 * once the platform has the report (or has moved on, a conflict), so a
 * restarted supervisor's first list does not find it and report it again.
 */
export async function settleRestoreFailure(
  failure: {
    runnerId: string;
    outcome: RestoreWatchResult & { ok: false };
    /** The dequeued run's route, which spares the platform a read to find it. */
    snapshotRoute?: SnapshotRouteWire;
  },
  deps: {
    deleteRunner: (runnerId: string, uid: string) => Promise<void>;
    report: RestoreOutcomeReport;
  }
): Promise<RestoreFailureSettlement> {
  const { reason, error, message, uid } = failure.outcome;
  const action = classifyRestoreFailure(reason);
  if (!action) {
    return { action: "none" };
  }
  if (action.outcome === "requeue" && action.deleteRunner) {
    if (!uid) {
      return { action: "kept", error: "no uid to guard the Runner's delete" };
    }
    try {
      await deps.deleteRunner(failure.runnerId, uid);
    } catch (err: unknown) {
      return {
        action: "kept",
        error: messageOf(err),
        ...(statusCodeOf(err) === 403 ? { forbidden: true } : {}),
      };
    }
  }
  const result = await deps.report({
    outcome: action.outcome,
    reason,
    message: message ?? error,
    ...(failure.snapshotRoute ? { snapshotRoute: failure.snapshotRoute } : {}),
  });
  const settled: Extract<RestoreFailureSettlement, { action: "reported" }> = result.success
    ? { action: "reported", outcome: action.outcome, result: "ok" }
    : {
        action: "reported",
        outcome: action.outcome,
        result: result.statusCode === 409 ? "conflict" : "error",
        error: result.error,
      };
  if (action.outcome === "fail" && settled.result !== "error" && uid) {
    try {
      await deps.deleteRunner(failure.runnerId, uid);
    } catch (err: unknown) {
      settled.cleanupError = messageOf(err);
    }
  }
  return settled;
}

function runnerGone(): RunnerRestoreResult {
  return { ok: false, reason: "RunnerGone", error: "the Runner no longer exists" };
}

function restoreTimedOut(timeoutMs: number): RunnerRestoreResult {
  return { ok: false, reason: "Timeout", error: `the Runner did not start within ${timeoutMs}ms` };
}

function isOverloaded(code: number | undefined): boolean {
  return code === 429 || (code !== undefined && code >= 500);
}

export function pollDelayMs(pollMs: number, overloaded: number, deadline: number): number {
  const backoff = Math.min(pollMs * 2 ** overloaded, Math.max(pollMs, MAX_POLL_BACKOFF_MS));
  return Math.max(0, Math.min(backoff, deadline - Date.now()));
}

function phaseOf(runner: unknown): string | undefined {
  return (runner as RunnerSuspendStatus | null)?.status?.phase;
}

/** The API server sends a string, and nothing on this path deserializes it. */
function createdAtOf(runner: unknown): Date | undefined {
  const created = (runner as { metadata?: { creationTimestamp?: string | Date } } | null)?.metadata
    ?.creationTimestamp;
  if (!created) {
    return undefined;
  }
  const date = new Date(created);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Whether a resume started, or undefined while the operator is still restoring
 * it. A Runner that ended is a success only if it ran to completion.
 */
export function restoreOutcome(runner: unknown): RunnerRestoreResult | undefined {
  const status = (runner as RunnerSuspendStatus | null)?.status;
  switch (status?.phase) {
    case "Running":
    case "Suspending":
    case "Succeeded":
      return { ok: true };
    case "Failed": {
      const condition = status.conditions?.find((c) => c.type === "Failed");
      return {
        ok: false,
        reason: condition?.reason ?? "Unknown",
        error: condition
          ? `${condition.reason}: ${condition.message}`
          : "the Runner failed with no reason recorded",
        ...(condition?.message ? { message: condition.message } : {}),
      };
    }
    default:
      return undefined;
  }
}

/**
 * The Runner's latest suspend, when it has an outcome the platform has not
 * been marked as accepting. A request made without the run annotation, by an
 * older supervisor, cannot be delivered and is skipped.
 */
export function publishedSuspend(runner: unknown): PublishedSuspend | undefined {
  const meta = (runner as { metadata?: { name?: string; annotations?: Record<string, string> } })
    ?.metadata;
  const request = meta?.annotations?.[SUSPEND_ANNOTATION];
  const runFriendlyId = meta?.annotations?.[SUSPEND_RUN_ANNOTATION];
  if (
    !meta?.name ||
    !request ||
    !runFriendlyId ||
    meta.annotations?.[SUSPEND_SUBMITTED_ANNOTATION] === request
  ) {
    return undefined;
  }
  const outcome = suspendOutcome(runner, request);
  return outcome && { runnerId: meta.name, runFriendlyId, snapshotFriendlyId: request, outcome };
}

type RunnerRestore = { snapshotID: string; node: string };

/**
 * A checkpoint's location names the node as well as the snapshot, because the
 * node runtime's snapshots are node-local and a resume has to land there.
 * Neither a node name nor a snapshot id can contain a slash.
 */
export function checkpointLocation(restore: RunnerRestore): string {
  return `${restore.node}/${restore.snapshotID}`;
}

export function parseCheckpointLocation(location: string): RunnerRestore {
  const [node, snapshotID, ...rest] = location.split("/");
  if (!node || !snapshotID || rest.length > 0) {
    throw new Error(`checkpoint location ${JSON.stringify(location)} is not <node>/<snapshot>`);
  }
  return { node, snapshotID };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Without a uid to compare, any Runner by the name is taken as this one. */
function isRunner(runner: unknown, uid: string | undefined): boolean {
  return uid === undefined || uidOf(runner) === uid;
}

/** The create response is untyped, and an absent uid just skips adoption. */
function uidOf(created: unknown): string | undefined {
  if (typeof created !== "object" || created === null) {
    return undefined;
  }
  const meta = (created as { metadata?: { uid?: unknown } }).metadata;
  return typeof meta?.uid === "string" ? meta.uid : undefined;
}

/**
 * The whole translation from what the platform dequeued into what the API server
 * stores, kept apart from the client because a wrong field here is a pod that
 * starts and behaves differently, not a request that fails.
 */
export function runnerBodyFor(
  opts: WorkloadManagerCreateOptions,
  meta: {
    name: string;
    namespace: string;
    runtime: RunnerRuntime;
    token?: { name: string; key: string };
    restore?: RunnerRestore;
  }
) {
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: "Runner",
    metadata: {
      // The runner id is the name, so a retried attempt collides.
      name: meta.name,
      namespace: meta.namespace,
      ...(meta.restore ? { labels: { [RESTORE_LABEL]: "true" } } : {}),
    },
    spec: {
      runtime: meta.runtime,
      // As built, digest and all: the operator owns stripping and rewriting, so
      // they cannot both apply.
      image: opts.image,
      machine: machineOf(opts.machine),
      ...(opts.runtime ? { taskRuntime: opts.runtime } : {}),
      deployment: {
        friendlyID: opts.deploymentFriendlyId,
        version: opts.deploymentVersion,
        // Field by field, not spread: the handle also carries the Secret's uid,
        // which the spec has no field for and Strict validation rejects by name.
        ...(meta.token ? { token: { name: meta.token.name, key: meta.token.key } } : {}),
      },
      owner: {
        envID: opts.envId,
        envType: opts.envType satisfies EnvironmentType,
        orgID: opts.orgId,
        projectID: opts.projectId,
      },
      bootstrap: {
        runFriendlyID: opts.runFriendlyId,
        snapshotFriendlyID: opts.snapshotFriendlyId,
        dequeuedAt: opts.dequeuedAt.toISOString(),
      },
      ...(opts.placementTags?.length
        ? {
            // Only the first value reaches a node selector.
            placementTags: opts.placementTags.map((tag) => ({
              key: tag.key,
              value: tag.values?.[0] ?? "",
            })),
          }
        : {}),
      // Carried, not derived: it decides affinity for every run this runner
      // later serves.
      ...(isScheduledRun(opts) ? { isScheduledRun: true } : {}),
      ...(opts.hasPrivateLink ? { hasPrivateLink: true } : {}),
      ...(meta.restore ? { restore: meta.restore } : {}),
    },
  };
}

/**
 * Decimal gigabytes, as the preset table is written: no integer count of binary
 * MiB equals a quarter of a gigabyte.
 */
function machineOf(machine: MachinePreset) {
  return {
    name: machine.name,
    cpu: `${machine.cpu}`,
    memory: `${machine.memory}G`,
  };
}

function isScheduledRun(opts: WorkloadManagerCreateOptions): boolean {
  return opts.annotations?.rootTriggerSource === "schedule";
}

/**
 * The runner id is already a legal Runner name; it is lowercased anyway because an
 * invalid Secret name fails the create. The token's digest is in the name because
 * the Secret is immutable, so a rotated key or moved expiry lands as a new Secret.
 *
 * The runner id is mixed into the digest so a listing cannot show which runners
 * share a token. It does not stop checking a known token against a name (the id
 * is in the name); that would need a salt this process does not have.
 */
export function runnerTokenSecretName(runnerId: string, token: string, nonce?: string): string {
  const id = runnerId.toLowerCase();
  const digest = createHash("sha256")
    .update(nonce ? `${id}:${token}:${nonce}` : `${id}:${token}`)
    .digest("hex")
    .slice(0, 8);
  return `${id}-token-${digest}`;
}

/** The client reports a status in several shapes depending on which layer raised it. */
function statusCodeOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const candidate = err as { code?: unknown; statusCode?: unknown; body?: { code?: unknown } };
  for (const value of [candidate.code, candidate.statusCode, candidate.body?.code]) {
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}
