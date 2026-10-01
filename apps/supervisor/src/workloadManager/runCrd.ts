import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PatchStrategy } from "@kubernetes/client-node";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import type { CheckpointType, EnvironmentType, MachinePreset } from "@trigger.dev/core/v3";
import { type K8sApi, createK8sApi } from "../clients/kubernetes.js";
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

/** Read errors that the next poll would only repeat. */
const TERMINAL_READ_CODES = new Set([400, 401, 403, 422]);

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
  /** How often and how long a suspend's outcome is read back off the Runner. */
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
};

export type RunnerRestoreResult = { ok: true } | { ok: false; error: string };

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

  constructor(opts: RunCrdWorkloadManagerOptions) {
    this.k8s = createK8sApi();
    this.namespace = opts.namespace;
    this.runtime = opts.runtime;
    this.snapshots = opts.snapshots;
    this.suspendPollMs = opts.suspendPollMs ?? 1_000;
    this.suspendTimeoutMs = opts.suspendTimeoutMs ?? 6 * 60_000;
    this.restoreTimeoutMs = opts.restoreTimeoutMs ?? 16 * 60_000;
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
    while (Date.now() < deadline) {
      await sleep(this.suspendPollMs);
      let runner: unknown;
      try {
        runner = await this.getRunner(opts.runnerId);
      } catch (err: unknown) {
        const code = statusCodeOf(err);
        if (code === 404) {
          return { ok: false, error: "the Runner no longer exists" };
        }
        if (code !== undefined && TERMINAL_READ_CODES.has(code)) {
          return { ok: false, error: `Runner read failed: ${messageOf(err)}` };
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
  async awaitRestore(runnerId: string): Promise<RunnerRestoreResult> {
    return awaitRestoreOf(() => this.getRunner(runnerId), {
      pollMs: this.suspendPollMs,
      timeoutMs: this.restoreTimeoutMs,
      onReadError: (err) =>
        this.logger.warn("[RunCrdWorkloadManager] Runner read failed during restore", {
          runnerId,
          rawError: err,
        }),
    });
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
   * rather than restoring twice. Returns the Runner's name, also for a resume
   * found in the way, which a restarted supervisor has no other watch on.
   */
  async restore(
    opts: WorkloadManagerCreateOptions,
    checkpoint: { id: string; location: string }
  ): Promise<string> {
    const runnerId = getRestoreRunnerId(opts.runFriendlyId, checkpoint.id);
    const restore = parseCheckpointLocation(checkpoint.location);
    const created = await this.createRunner(opts, runnerId, restore);
    if (!created) {
      await this.checkExistingRestore(runnerId, restore);
    }
    return runnerId;
  }

  /**
   * A resume already in the way counts as this restore only while it is still
   * live and restores the same snapshot. One held terminal for the operator's
   * TTL will never resume the guest, so the dequeue must not be reported done.
   */
  private async checkExistingRestore(runnerId: string, restore: RunnerRestore) {
    const existing = (await this.getRunner(runnerId)) as ExistingRestore | null;
    const phase = existing?.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") {
      throw new Error(`restore Runner ${runnerId} already ended (${phase})`);
    }
    const spec = existing?.spec?.restore;
    if (spec?.snapshotID !== restore.snapshotID || spec?.node !== restore.node) {
      throw new Error(
        `restore Runner ${runnerId} restores ${JSON.stringify(spec ?? null)}, not ${checkpointLocation(restore)}`
      );
    }
    this.logger.warn("[RunCrdWorkloadManager] Restore Runner already exists", { runnerId, phase });
  }

  /** Returns false when a resume's Runner was already there. */
  private async createRunner(
    opts: WorkloadManagerCreateOptions,
    runnerId: string,
    restore?: RunnerRestore
  ): Promise<boolean> {
    const token = await this.ensureRunnerToken(opts, runnerId);

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
    return true;
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
   */
  private async ensureRunnerToken(
    opts: WorkloadManagerCreateOptions,
    runnerId: string
  ): Promise<{ name: string; key: string; uid?: string } | undefined> {
    if (!opts.deploymentToken) {
      return undefined;
    }

    const name = runnerTokenSecretName(runnerId, opts.deploymentToken);

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
  opts: { pollMs: number; timeoutMs: number; onReadError: (err: unknown) => void }
): Promise<RunnerRestoreResult> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(opts.pollMs);
    let runner: unknown;
    try {
      runner = await readRunner();
    } catch (err: unknown) {
      const code = statusCodeOf(err);
      if (code === 404) {
        return { ok: false, error: "the Runner no longer exists" };
      }
      if (code !== undefined && TERMINAL_READ_CODES.has(code)) {
        return { ok: false, error: `Runner read failed: ${messageOf(err)}` };
      }
      opts.onReadError(err);
      continue;
    }
    const outcome = restoreOutcome(runner);
    if (outcome) {
      return outcome;
    }
  }
  return { ok: false, error: `the Runner did not start within ${opts.timeoutMs}ms` };
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
        error: condition
          ? `${condition.reason}: ${condition.message}`
          : "the Runner failed with no reason recorded",
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
export function runnerTokenSecretName(runnerId: string, token: string): string {
  const id = runnerId.toLowerCase();
  const digest = createHash("sha256").update(`${id}:${token}`).digest("hex").slice(0, 8);
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
