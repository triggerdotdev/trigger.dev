import type { V1Pod } from "@kubernetes/client-node";
import type { WorkloadDeploymentTokenClaims } from "@trigger.dev/core/v3";
import {
  SecretProxyExecution,
  type SupervisorHttpClient,
} from "@trigger.dev/core/v3/runEngineWorker";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { isIP } from "node:net";
import { z } from "zod";
import { Counter, Gauge } from "prom-client";
import { register } from "../metrics.js";
import { type K8sApi, withTimeout } from "../clients/kubernetes.js";
import { attemptOfRunnerId } from "../util.js";

const CONTROL_TIMEOUT_MS = 2_000;
const MAX_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
const KUBERNETES_TIMEOUT_MS = 5_000;
const MAX_BINDINGS = 128;
const MAX_PLACEMENTS = 4096;
const MAX_IN_FLIGHT = 16;
const UNBOUND_CACHE_MS = 60_000;
const CLEANUP_INTERVAL_MS = 10_000;
const COMPLETION_RETRY_MS = 5 * 60_000;
const INITIAL_CONTROL_RETRY_MS = CLEANUP_INTERVAL_MS;
const MAX_CONTROL_RETRY_MS = 60_000;
const INITIAL_START_FAILURE_RETRY_MS = 1_000;
const MAX_START_FAILURE_RETRY_MS = 60_000;

const RESTORED_ATTEMPT = 0;

const controlRequests = new Counter({
  name: "supervisor_secret_proxy_control_requests_total",
  help: "Local interceptor control calls by bounded operation and outcome",
  labelNames: ["operation", "outcome"],
  registers: [register],
});
for (const operation of ["reset", "lookup", "bind", "revoke"]) {
  for (const outcome of ["success", "error"]) controlRequests.inc({ operation, outcome }, 0);
}

const continuedBindings = new Counter({
  name: "supervisor_secret_proxy_continued_bindings_total",
  help: "Executions that lost their binding mid-attempt (a failed continue bind or a suspend that was not accepted), by whether a later heartbeat bound them again",
  labelNames: ["trigger", "outcome"],
  registers: [register],
});
for (const trigger of ["continue", "suspend"]) {
  for (const outcome of ["bound", "lost"]) continuedBindings.inc({ trigger, outcome }, 0);
}

function readinessMetric(): Gauge {
  const existing = register.getSingleMetric("supervisor_secret_proxy_ready");
  if (existing instanceof Gauge) return existing;
  return new Gauge({
    name: "supervisor_secret_proxy_ready",
    help: "Proxy supervisor binding discovery succeeded; not per-allocation connectivity",
    registers: [register],
  });
}

const Runner = z.object({
  metadata: z.object({
    name: z.string(),
    uid: z.string().min(1),
    namespace: z.string(),
    deletionTimestamp: z.unknown().optional(),
  }),
  spec: z.object({
    runtime: z.literal("microvm"),
    owner: z.object({ envID: z.string() }),
    deployment: z.object({ friendlyID: z.string() }),
    bootstrap: z.object({ runFriendlyID: z.string() }),
    restore: z.unknown().optional(),
    singleUse: z.boolean().optional(),
  }),
});

export type SecretProxyCaller = {
  runId: string;
  runnerId?: string;
  sourceIp?: string;
  claims?: WorkloadDeploymentTokenClaims;
};

const Allocation = z.object({
  allocationId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  guestId: z.string().min(1),
  runId: z.string().min(1),
  attempt: z.number().int().nonnegative().safe(),
  bindingId: z.string().min(1),
  empty: z.boolean(),
  hasBeenBound: z.boolean(),
  binding: SecretProxyExecution.extend({
    bindingId: z.string().min(1),
    sourceIp: z.string(),
  }).nullish(),
});

type Identity = {
  allocationId: string;
  bindingId: string;
  guestId: string;
  sourceIp: string;
  runId: string;
  attempt: number;
  runnerId: string;
  runnerUid: string;
  podUid: string;
  environmentId: string;
  deploymentId: string;
  singleUseAttempt?: number;
  pinned?: boolean;
};

export type SecretProxyPlacement = Pick<
  Identity,
  | "allocationId"
  | "bindingId"
  | "guestId"
  | "sourceIp"
  | "runnerId"
  | "runnerUid"
  | "podUid"
  | "environmentId"
  | "deploymentId"
  | "singleUseAttempt"
  | "pinned"
> & { isWarmStart: boolean; continuing?: boolean };

export type SecretProxyStartResult = {
  execution: {
    run: { id: string };
    attempt: { number: number };
    environment: { id: string };
    deployment?: { id: string };
  };
  snapshot: { friendlyId: string; createdAt: Date };
  secretProxy?: SecretProxyExecution;
  envVars: Record<string, string>;
};

export type SecretProxyContinueResult = {
  run: { friendlyId: string; attemptNumber?: number | null };
  snapshot: { friendlyId: string; createdAt: Date };
  runToken?: string;
  secretProxy?: SecretProxyExecution;
};

type Binding = Identity & {
  expiresAtMs: number;
  busy: boolean;
  completed: boolean;
  proxy?: SecretProxyExecution;
  runToken?: string;
};

export type RunExecution = {
  run: { attemptNumber?: number | null };
  snapshot: { friendlyId: string; executionStatus: string };
  checkpoint?: unknown;
};

/** An execution in these states stays in process; any other may have moved to another VM. */
const IN_PROCESS_STATUSES = new Set(["EXECUTING", "EXECUTING_WITH_WAITPOINTS"]);
/** The platform returns at most this many executions since a snapshot; a full page is unproven. */
const MAX_SNAPSHOTS_SINCE = 50;

type PendingRebind = {
  trigger: "continue" | "suspend";
  /** The suspend whose outcome decides whether to rebind; unset once it is known. */
  suspend?: string;
  /** The execution snapshot the VM last held authority at. */
  since: string;
  runnerId: string;
  attempt: number;
  proxy: SecretProxyExecution;
  runToken?: string;
  ready: boolean;
  busy: boolean;
};

export class SecretProxyAllocationBusyError extends Error {
  constructor(
    readonly runner: Pick<Identity, "runnerId" | "runnerUid">,
    readonly discovered?: { runId: string; guestId: string; bindingId: string }
  ) {
    super("Secret proxy allocation is busy");
  }
}

export class SecretProxyPlacementPendingError extends Error {
  constructor(readonly matches: (caller: SecretProxyCaller) => boolean) {
    super("Secret proxy placement waiting for Pod status");
  }
}

/** A caller already waiting for Pod status found every lookup slot in use; it keeps waiting. */
export class SecretProxyPlacementSaturatedError extends SecretProxyPlacementPendingError {
  constructor() {
    super(() => true);
  }
}

type CompletionResponse = Awaited<ReturnType<SupervisorHttpClient["completeRunAttempt"]>>;
function denied(): never {
  // Do not propagate API or token parsing errors into request logs.
  throw new Error("Secret proxy execution unavailable");
}

function sourceIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return isIP(normalized) ? normalized : undefined;
}

export function isSecretProxyHostname(host: string): boolean {
  return (
    host.length <= 253 &&
    !isIP(host) &&
    host.includes(".") &&
    host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

function matchesPlacementCaller(
  identity: Pick<Identity, "runnerId" | "sourceIp" | "environmentId" | "deploymentId">,
  caller: SecretProxyCaller
): boolean {
  return (
    identity.runnerId === caller.runnerId &&
    identity.sourceIp === sourceIp(caller.sourceIp) &&
    identity.environmentId === caller.claims?.environment_id &&
    identity.deploymentId === caller.claims?.deployment
  );
}

function matchesCaller(identity: Identity, caller: SecretProxyCaller): boolean {
  return identity.runId === caller.runId && matchesPlacementCaller(identity, caller);
}

/** Whether kubelet has published the Pod status placement needs, and whether it matches the caller. */
function publishedPodStatus(
  pod: V1Pod,
  ip: string | undefined
): "denied" | "pending" | { guestId: string } {
  const container = pod.spec?.containers[0]?.name;
  const status = pod.status?.containerStatuses?.find((s) => s.name === container);
  const guestId = status?.containerID?.match(/^containerd:\/\/([a-zA-Z0-9_-]+)$/)?.[1];
  const podIP = pod.status?.podIP;
  if (
    (podIP && sourceIp(podIP) !== ip) ||
    (status?.containerID && !guestId) ||
    status?.state?.terminated ||
    pod.status?.phase === "Failed" ||
    pod.status?.phase === "Succeeded"
  )
    return "denied";
  if (!podIP || !guestId || !status?.state?.running) return "pending";
  return { guestId };
}

type CachedPlacement = ReturnType<typeof trustedSecretProxyIdentity> & {
  allocationId: string;
  hasBeenBound: boolean;
  bindingId?: string;
  boundAttempt?: number;
};

export function trustedSecretProxyIdentity(
  runnerObject: unknown,
  pod: V1Pod,
  caller: SecretProxyCaller,
  nodeName: string,
  namespace: string
): Omit<Identity, "allocationId" | "bindingId" | "runId" | "attempt"> & {
  bootstrapRunId: string;
  bootstrapAttempt: number;
} {
  const parsed = Runner.safeParse(runnerObject);
  if (!parsed.success) return denied();
  const runner = parsed.data;
  const ip = sourceIp(caller.sourceIp);
  const attempt = runner.spec.restore
    ? RESTORED_ATTEMPT
    : caller.runnerId
      ? attemptOfRunnerId(caller.runnerId, runner.spec.bootstrap.runFriendlyID)
      : undefined;
  const container = pod.spec?.containers[0]?.name;
  if (
    !caller.claims ||
    !ip ||
    attempt === undefined ||
    !container ||
    !pod.metadata?.uid ||
    runner.metadata.deletionTimestamp ||
    pod.metadata.deletionTimestamp ||
    runner.metadata.namespace !== namespace ||
    pod.metadata.namespace !== namespace ||
    runner.metadata.name !== caller.runnerId ||
    pod.metadata.name !== caller.runnerId ||
    (runner.spec.singleUse && caller.runId !== runner.spec.bootstrap.runFriendlyID) ||
    runner.spec.owner.envID !== caller.claims.environment_id ||
    runner.spec.deployment.friendlyID !== caller.claims.deployment ||
    !pod.metadata.ownerReferences?.some(
      (owner) =>
        owner.kind === "Runner" &&
        owner.apiVersion === "compute.trigger.dev/v1alpha1" &&
        owner.uid === runner.metadata.uid &&
        owner.name === runner.metadata.name &&
        owner.controller === true
    ) ||
    !nodeName ||
    pod.spec?.nodeName !== nodeName ||
    pod.spec.hostNetwork
  )
    return denied();
  const published = publishedPodStatus(pod, ip);
  if (published === "denied") return denied();
  if (published === "pending") {
    const scope = {
      runnerId: runner.metadata.name,
      sourceIp: ip,
      environmentId: runner.spec.owner.envID,
      deploymentId: runner.spec.deployment.friendlyID,
    };
    // A coalesced lookup must not make another caller with different claims wait.
    throw new SecretProxyPlacementPendingError(
      (other) =>
        matchesPlacementCaller(scope, other) &&
        (!runner.spec.singleUse || other.runId === runner.spec.bootstrap.runFriendlyID)
    );
  }
  return {
    guestId: published.guestId,
    podUid: pod.metadata.uid,
    sourceIp: ip,
    bootstrapRunId: runner.spec.bootstrap.runFriendlyID,
    bootstrapAttempt: attempt,
    singleUseAttempt: runner.spec.singleUse && !runner.spec.restore ? attempt : undefined,
    pinned: !!runner.spec.singleUse,
    runnerId: runner.metadata.name,
    runnerUid: runner.metadata.uid,
    environmentId: runner.spec.owner.envID,
    deploymentId: runner.spec.deployment.friendlyID,
  };
}

/** Only call with a token received over the authenticated supervisor/platform connection. */
function platformTokenExpiry(
  token: string,
  identity: Pick<Identity, "runId" | "attempt" | "environmentId" | "deploymentId">
): number {
  try {
    if (token.length > 32_768 || token.split(".").length !== 3) return denied();
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    if (
      claims.run_id !== identity.runId ||
      claims.attempt !== identity.attempt ||
      claims.environment_id !== identity.environmentId ||
      claims.deployment_id !== identity.deploymentId ||
      !Number.isSafeInteger(claims.exp) ||
      !Number.isSafeInteger(claims.exp * 1000) ||
      claims.exp * 1000 <= Date.now()
    )
      return denied();
    return claims.exp * 1000;
  } catch {
    return denied();
  }
}

async function interceptorRequest(
  socketPath: string,
  path: string,
  method: "GET" | "PUT" | "DELETE",
  body?: object
): Promise<string> {
  const operation =
    method === "GET"
      ? "lookup"
      : path === "/bindings"
        ? "reset"
        : method === "PUT"
          ? "bind"
          : "revoke";
  let outcome: "success" | "error" = "error";
  try {
    const socket = await lstat(socketPath);
    if (
      !socket.isSocket() ||
      (socket.mode & 0o077) !== 0 ||
      (socket.uid !== 0 && socket.uid !== process.getuid?.())
    )
      return denied();
    const result = await new Promise<string>((resolve, reject) => {
      const fail = () => reject(new Error("Secret proxy control unavailable"));
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath,
          path,
          method,
          headers:
            data === undefined
              ? undefined
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(data),
                },
        },
        (res) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_CONTROL_RESPONSE_BYTES)
              req.destroy(new Error("Control response too large"));
            else chunks.push(chunk);
          });
          res.on("error", fail);
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            const accepted =
              method === "GET"
                ? status === 200
                : path === "/bindings"
                  ? status === 204
                  : (status >= 200 && status < 300) || (method === "DELETE" && status === 404);
            if (accepted) resolve(Buffer.concat(chunks).toString("utf8"));
            else fail();
          });
        }
      );
      const timer = setTimeout(() => req.destroy(new Error("Control timeout")), CONTROL_TIMEOUT_MS);
      req.on("error", fail);
      req.on("close", () => clearTimeout(timer));
      req.end(data);
    });
    outcome = "success";
    return result;
  } finally {
    controlRequests.inc({ operation, outcome });
  }
}

export async function interceptorControl(
  socketPath: string,
  bindingId?: string,
  body?: object
): Promise<void> {
  await interceptorRequest(
    socketPath,
    bindingId === undefined ? "/bindings" : `/bindings/${encodeURIComponent(bindingId)}`,
    body === undefined ? "DELETE" : "PUT",
    body
  );
}

async function allocationForGuest(socketPath: string, guestId: string) {
  try {
    return Allocation.parse(
      JSON.parse(
        await interceptorRequest(socketPath, `/allocations/${encodeURIComponent(guestId)}`, "GET")
      )
    );
  } catch {
    return denied();
  }
}

export class SecretProxyBindings {
  private readonly bindings = new Map<string, Binding>();
  private readonly failedStarts = new Map<
    string,
    {
      runId: string;
      complete: () => Promise<CompletionResponse>;
      revoke: boolean;
      busy: boolean;
      expiresAtMs: number;
      nextRetryAtMs: number;
      retryMs: number;
    }
  >();
  private readonly starting = new Map<string, SecretProxyPlacement | Binding>();
  private readonly retiredStarts = new WeakSet<SecretProxyPlacement | Binding>();
  private readonly placements = new Map<string, CachedPlacement>();
  private readonly runnerPlacements = new Map<string, string>();
  private readonly placementLookups = new Map<
    string,
    { promise: Promise<CachedPlacement | undefined> }
  >();
  private readonly recoverable = new Map<string, Set<string>>();
  private readonly pendingRevocations = new Map<string, Set<string>>();
  private readonly rebinds = new Map<string, PendingRebind>();
  private discovery?: Promise<void>;
  private verifying = 0;
  private controlling = 0;
  private readonly controls = new Set<Promise<void>>();
  private stopped = false;
  private ready = false;
  private nextControlRetryAt = 0;
  private controlRetryMs = INITIAL_CONTROL_RETRY_MS;
  private readonly cleanup: NodeJS.Timeout;
  private readonly readiness = readinessMetric();

  constructor(
    private readonly opts: {
      k8s: {
        core: Pick<K8sApi["core"], "readNamespacedPod">;
        custom: Pick<K8sApi["custom"], "getNamespacedCustomObject">;
      };
      namespace: string;
      nodeName: string;
      socketPath: string;
      completionGraceMs?: number;
      /** The run's executions after a snapshot, from the authenticated platform connection. */
      snapshotsSince?: (caller: SecretProxyCaller, snapshotId: string) => Promise<RunExecution[]>;
      /** The run's latest execution, read from the primary. */
      latestExecution?: (caller: SecretProxyCaller) => Promise<RunExecution>;
    }
  ) {
    this.readiness.set(0);
    this.cleanup = setInterval(() => void this.expire(), CLEANUP_INTERVAL_MS);
    this.cleanup.unref();
  }

  start(): Promise<void> {
    return (this.discovery ??= this.discover().finally(() => {
      this.discovery = undefined;
    }));
  }

  private async discover(): Promise<void> {
    try {
      const runs = z
        .array(
          z.object({
            runId: z.string().min(1),
            guestId: z.string().min(1),
            revokeBindingId: z.string().min(1).optional(),
          })
        )
        .parse(JSON.parse(await interceptorRequest(this.opts.socketPath, "/bindings", "GET")));
      if (this.stopped) return;
      for (const { runId, guestId, revokeBindingId } of runs) {
        const [map, value] = revokeBindingId
          ? [this.pendingRevocations, revokeBindingId]
          : [this.recoverable, guestId];
        const values = map.get(runId) ?? new Set<string>();
        values.add(value);
        map.set(runId, values);
      }
      this.ready = true;
      this.readiness.set(1);
    } catch {
      this.readiness.set(0);
      this.nextControlRetryAt = Date.now() + this.controlRetryMs;
      this.controlRetryMs = Math.min(this.controlRetryMs * 2, MAX_CONTROL_RETRY_MS);
    }
  }

  tracks(runId: string): boolean {
    return this.bindings.has(runId) || this.recoverable.has(runId);
  }

  private async finishRevocations(runId: string): Promise<void> {
    const bindingIds = this.pendingRevocations.get(runId);
    if (!bindingIds) return;
    for (const bindingId of bindingIds) {
      await this.control(bindingId);
      bindingIds.delete(bindingId);
    }
    this.pendingRevocations.delete(runId);
  }

  private atCapacity(runId: string): boolean {
    const now = Date.now();
    const pending = [...this.failedStarts.values()].filter((failure) => failure.expiresAtMs > now);
    if (pending.length >= MAX_BINDINGS) return true;
    if (this.bindings.has(runId)) return false;
    return (
      [...this.bindings.values()].filter(
        (binding) =>
          (this.failedStarts.get(binding.bindingId)?.expiresAtMs ?? binding.expiresAtMs) > now
      ).length >= MAX_BINDINGS
    );
  }

  private forgetPlacement(placement: CachedPlacement): void {
    if (this.placements.get(placement.podUid) !== placement) return;
    this.placements.delete(placement.podUid);
    if (this.runnerPlacements.get(placement.runnerId) === placement.podUid)
      this.runnerPlacements.delete(placement.runnerId);
  }

  private currentPlacement(placement: SecretProxyPlacement): CachedPlacement {
    const cached = this.placements.get(placement.podUid);
    if (
      !cached ||
      this.retiredStarts.has(placement) ||
      cached.runnerUid !== placement.runnerUid ||
      cached.allocationId !== placement.allocationId
    )
      return denied();
    return cached;
  }

  private async readPlacement(
    caller: SecretProxyCaller,
    recovering = false
  ): Promise<CachedPlacement & { binding?: z.infer<typeof Allocation>["binding"] }> {
    const [runner, pod] = await Promise.allSettled([
      this.opts.k8s.custom.getNamespacedCustomObject({
        group: "compute.trigger.dev",
        version: "v1alpha1",
        plural: "runners",
        namespace: this.opts.namespace,
        name: caller.runnerId!,
      }),
      this.opts.k8s.core.readNamespacedPod({
        namespace: this.opts.namespace,
        name: caller.runnerId!,
      }),
    ]);
    if (runner.status === "rejected") throw runner.reason;
    if (pod.status === "rejected") throw pod.reason;
    const placement = trustedSecretProxyIdentity(
      runner.value,
      pod.value,
      caller,
      this.opts.nodeName,
      this.opts.namespace
    );
    const allocation = await allocationForGuest(this.opts.socketPath, placement.guestId);
    if (
      allocation.runId !== placement.bootstrapRunId ||
      allocation.attempt !== placement.bootstrapAttempt ||
      allocation.guestId !== placement.guestId
    )
      return denied();
    if (!recovering) await this.requireEmpty(allocation, placement);
    return {
      ...placement,
      allocationId: allocation.allocationId,
      hasBeenBound: allocation.hasBeenBound,
      ...(recovering ? { binding: allocation.binding, bindingId: allocation.bindingId } : {}),
    };
  }

  private remember(placement: CachedPlacement): void {
    const previous = this.placements.get(this.runnerPlacements.get(placement.runnerId) ?? "");
    if (previous) this.forgetPlacement(previous);
    if (this.placements.size >= MAX_PLACEMENTS)
      this.forgetPlacement(this.placements.values().next().value!);
    this.placements.set(placement.podUid, placement);
    this.runnerPlacements.set(placement.runnerId, placement.podUid);
  }

  private async recover(caller: SecretProxyCaller): Promise<void> {
    const guests = this.recoverable.get(caller.runId);
    if (!guests || this.bindings.has(caller.runId)) return;
    if (this.stopped || !caller.runnerId || this.verifying >= MAX_IN_FLIGHT) return denied();
    this.verifying++;
    const read = this.readPlacement(caller, true).finally(() => this.verifying--);
    const found = await withTimeout(read, KUBERNETES_TIMEOUT_MS, "Secret proxy recovery");
    if (this.stopped || !guests.has(found.guestId)) return denied();
    const { binding: recovered, ...placement } = found;
    if (recovered && recovered.runId === caller.runId) {
      if (
        recovered.bindingId !== placement.bindingId ||
        recovered.sourceIp !== placement.sourceIp ||
        recovered.allowedHosts.some((host) => !isSecretProxyHostname(host))
      )
        return denied();
      if (this.bindings.has(caller.runId)) return;
      this.remember({
        ...placement,
        hasBeenBound: true,
        ...(placement.pinned ? { boundAttempt: recovered.attempt } : {}),
      });
      this.bindings.set(caller.runId, {
        ...placement,
        bindingId: recovered.bindingId,
        runId: recovered.runId,
        attempt: recovered.attempt,
        expiresAtMs: Math.max(recovered.expiresAtMs, Date.now() + UNBOUND_CACHE_MS),
        busy: false,
        completed: false,
        proxy: recovered,
      });
    }
    guests.delete(found.guestId);
    if (guests.size === 0) this.recoverable.delete(caller.runId);
  }

  /**
   * `retrying` marks a caller already told its Pod status is pending: a saturated lookup then
   * reports pending too, so a burst doesn't end its wait early.
   */
  async prepareStart(
    caller: SecretProxyCaller,
    { continuing = false, retrying = false } = {}
  ): Promise<SecretProxyPlacement | undefined> {
    if (
      !this.ready ||
      this.stopped ||
      !caller.claims ||
      !caller.runnerId ||
      !sourceIp(caller.sourceIp)
    )
      return;
    let cached = this.placements.get(this.runnerPlacements.get(caller.runnerId) ?? "");
    const allocation = cached && (await this.cachedAllocation(cached));
    if (cached && !allocation) {
      this.forgetPlacement(cached);
      cached = undefined;
    }
    if (cached && allocation) {
      if (!matchesPlacementCaller(cached, caller)) return;
      if (!cached.bindingId) {
        try {
          await this.requireEmpty(allocation, cached);
        } catch (error) {
          if (error instanceof SecretProxyAllocationBusyError) throw error;
          this.forgetPlacement(cached);
          return;
        }
      }
    }
    if (!cached) {
      let pending = this.placementLookups.get(caller.runnerId);
      if (!pending) {
        if (this.verifying >= MAX_IN_FLIGHT) {
          if (retrying) throw new SecretProxyPlacementSaturatedError();
          return;
        }
        this.verifying++;
        const read = this.readPlacement(caller).finally(() => this.verifying--);
        pending = {
          promise: withTimeout(read, KUBERNETES_TIMEOUT_MS, "Secret proxy identity")
            .then((placement) => {
              if (
                this.stopped ||
                !this.ready ||
                this.placementLookups.get(placement.runnerId) !== pending
              )
                return;
              this.remember(placement);
              return placement;
            })
            .catch((error) => {
              if (
                error instanceof SecretProxyAllocationBusyError ||
                (error instanceof SecretProxyPlacementPendingError &&
                  !this.stopped &&
                  this.ready &&
                  this.placementLookups.get(caller.runnerId!) === pending)
              )
                throw error;
              return undefined;
            })
            .finally(() => {
              if (this.placementLookups.get(caller.runnerId!) === pending)
                this.placementLookups.delete(caller.runnerId!);
            }),
        };
        this.placementLookups.set(caller.runnerId, pending);
      }
      try {
        cached = await pending.promise;
      } catch (error) {
        if (error instanceof SecretProxyPlacementPendingError && !error.matches(caller)) return;
        throw error;
      }
    }
    if (
      !cached ||
      this.stopped ||
      !this.ready ||
      this.placements.get(cached.podUid) !== cached ||
      !matchesPlacementCaller(cached, caller) ||
      (cached.pinned && caller.runId !== cached.bootstrapRunId)
    )
      return;
    if (cached.bindingId || (cached.pinned && cached.hasBeenBound && !continuing))
      throw new SecretProxyAllocationBusyError(cached);
    this.placements.delete(cached.podUid);
    this.placements.set(cached.podUid, cached);
    return {
      ...cached,
      bindingId: randomUUID(),
      isWarmStart: caller.runId !== cached.bootstrapRunId || cached.hasBeenBound,
      continuing,
    };
  }

  private async cachedAllocation(
    cached: CachedPlacement
  ): Promise<z.infer<typeof Allocation> | undefined> {
    try {
      const allocation = await allocationForGuest(this.opts.socketPath, cached.guestId);
      if (
        allocation.allocationId !== cached.allocationId ||
        allocation.runId !== cached.bootstrapRunId ||
        allocation.attempt !== cached.bootstrapAttempt
      )
        return;
      cached.hasBeenBound ||= allocation.hasBeenBound;
      return allocation;
    } catch {
      return;
    }
  }

  private async requireEmpty(
    allocation: z.infer<typeof Allocation>,
    placement: Pick<Identity, "runnerId" | "runnerUid">
  ): Promise<void> {
    if (allocation.empty) return;
    for (const binding of this.bindings.values()) {
      if (
        binding.allocationId === allocation.allocationId &&
        binding.bindingId === allocation.bindingId
      )
        throw new SecretProxyAllocationBusyError(placement);
    }
    for (const [runId, guests] of this.recoverable) {
      if (guests.has(allocation.guestId))
        throw new SecretProxyAllocationBusyError(placement, {
          runId,
          guestId: allocation.guestId,
          bindingId: allocation.bindingId,
        });
    }
    await this.control(allocation.bindingId);
    const current = await allocationForGuest(this.opts.socketPath, allocation.guestId);
    if (current.allocationId !== allocation.allocationId || !current.empty)
      throw new SecretProxyAllocationBusyError(placement);
  }

  async withStart<T>(placement: SecretProxyPlacement, operation: () => Promise<T>): Promise<T> {
    if (this.stopped || !this.ready) return denied();
    if (this.starting.has(placement.allocationId))
      throw new SecretProxyAllocationBusyError(placement);
    this.starting.set(placement.allocationId, placement);
    try {
      const cached = this.currentPlacement(placement);
      if (cached.bindingId || (cached.pinned && cached.hasBeenBound && !placement.continuing))
        throw new SecretProxyAllocationBusyError(placement);
      placement.isWarmStart ||= cached.hasBeenBound;
      return await operation();
    } finally {
      this.starting.delete(placement.allocationId);
    }
  }

  async authorize(caller: SecretProxyCaller, completing = false): Promise<void> {
    if (this.stopped || !caller.claims || !caller.runnerId || !sourceIp(caller.sourceIp))
      return denied();
    if (!this.bindings.has(caller.runId) && this.recoverable.has(caller.runId)) {
      if (completing) return;
      await this.recover(caller);
    }
    const binding = this.bindings.get(caller.runId);
    if (!binding) return;
    if (
      !matchesCaller(binding, caller) ||
      (!completing && (binding.completed || binding.expiresAtMs <= Date.now()))
    )
      return denied();
  }

  /** Only call with a successful response from the authenticated platform connection. */
  async activateStart(
    caller: SecretProxyCaller,
    placement: SecretProxyPlacement,
    response: Omit<SecretProxyStartResult, "snapshot">
  ): Promise<void> {
    const { execution } = response;
    const protectedStart = response.secretProxy !== undefined;
    const cached = this.currentPlacement(placement);
    const pinnedAttempt = placement.singleUseAttempt ?? cached.boundAttempt;
    if (
      this.stopped ||
      !this.ready ||
      (cached.pinned &&
        (execution.run.id !== cached.bootstrapRunId ||
          (pinnedAttempt === undefined
            ? cached.hasBeenBound
            : execution.attempt.number !== pinnedAttempt))) ||
      execution.run.id !== caller.runId ||
      execution.environment.id !== placement.environmentId ||
      execution.deployment?.id !== placement.deploymentId ||
      placement.runnerId !== caller.runnerId ||
      placement.sourceIp !== sourceIp(caller.sourceIp) ||
      caller.claims?.environment_id !== placement.environmentId ||
      caller.claims.deployment !== placement.deploymentId ||
      !Number.isSafeInteger(execution.attempt.number) ||
      execution.attempt.number <= 0 ||
      (placement.singleUseAttempt !== undefined &&
        execution.attempt.number !== placement.singleUseAttempt) ||
      this.starting.get(placement.allocationId) !== placement ||
      this.bindings.get(caller.runId)?.busy ||
      (protectedStart && this.atCapacity(caller.runId))
    )
      return denied();
    const binding: Binding = {
      ...placement,
      runId: execution.run.id,
      attempt: execution.attempt.number,
      expiresAtMs: Date.now() + UNBOUND_CACHE_MS,
      busy: false,
      completed: false,
    };
    this.bindings.set(execution.run.id, binding);
    binding.busy = true;
    cached.bindingId = binding.bindingId;
    try {
      await interceptorRequest(
        this.opts.socketPath,
        `/allocations/${encodeURIComponent(binding.allocationId)}/binding`,
        "PUT",
        { bindingId: binding.bindingId }
      );
      cached.hasBeenBound = true;
      if (cached.pinned) cached.boundAttempt = execution.attempt.number;
      if (this.currentPlacement(placement) !== cached) return denied();
      if (response.secretProxy) {
        await this.attach(
          binding.runId,
          response.secretProxy,
          response.envVars.TRIGGER_RUN_TOKEN ?? ""
        );
      } else {
        await this.closeBinding(binding);
        this.bindings.delete(binding.runId);
      }
      if (this.currentPlacement(placement) !== cached) return denied();
      this.rebinds.delete(execution.run.id);
    } catch (error) {
      if (!protectedStart && !this.retiredStarts.has(placement)) {
        if (this.bindings.get(binding.runId) === binding) this.bindings.delete(binding.runId);
        return;
      }
      this.forgetPlacement(cached);
      throw error;
    } finally {
      binding.busy = false;
    }
  }

  async exclusive<T>(
    runId: string,
    operation: () => Promise<T>,
    runnerId: string | undefined,
    completing = false
  ): Promise<T> {
    if (!this.bindings.has(runId)) return operation();
    const binding = completing ? this.bindings.get(runId)! : this.get(runId);
    if (
      binding.busy ||
      this.starting.has(binding.allocationId) ||
      binding.runnerId !== runnerId ||
      (binding.completed && !completing)
    )
      return denied();
    binding.busy = true;
    this.starting.set(binding.allocationId, binding);
    try {
      return await operation();
    } finally {
      binding.busy = false;
      if (this.starting.get(binding.allocationId) === binding)
        this.starting.delete(binding.allocationId);
    }
  }

  async failStart(
    caller: SecretProxyCaller,
    bindingId: string,
    operation: () => Promise<CompletionResponse>
  ): Promise<void> {
    const binding = this.bindings.get(caller.runId);
    this.failedStarts.set(bindingId, {
      runId: caller.runId,
      complete: operation,
      revoke: binding?.bindingId === bindingId,
      busy: false,
      expiresAtMs:
        binding?.bindingId === bindingId ? binding.expiresAtMs : Date.now() + UNBOUND_CACHE_MS,
      nextRetryAtMs: 0,
      retryMs: INITIAL_START_FAILURE_RETRY_MS,
    });
  }

  async retryFailedStart(bindingId: string): Promise<void> {
    const failure = this.failedStarts.get(bindingId);
    if (!failure || failure.busy || this.stopped || Date.now() < failure.nextRetryAtMs) return;
    failure.busy = true;
    const binding = this.bindings.get(failure.runId);
    const recover = async () => {
      if (binding?.bindingId === bindingId) await this.revokeBinding(binding);
      else if (failure.revoke) await this.control(bindingId);

      let settled = Date.now() >= failure.expiresAtMs;
      if (!settled) {
        const response = await failure.complete();
        settled =
          response.success ||
          (response.statusCode !== undefined &&
            response.statusCode >= 400 &&
            response.statusCode < 500 &&
            response.statusCode !== 408 &&
            response.statusCode !== 429);
      }
      if (settled) {
        if (this.bindings.get(failure.runId)?.bindingId === bindingId)
          this.bindings.delete(failure.runId);
        this.failedStarts.delete(bindingId);
      }
    };
    try {
      if (binding?.bindingId === bindingId) {
        await this.exclusive(binding.runId, recover, binding.runnerId, true);
      } else {
        await recover();
      }
    } catch {
    } finally {
      failure.busy = false;
      failure.nextRetryAtMs = Date.now() + failure.retryMs;
      failure.retryMs = Math.min(failure.retryMs * 2, MAX_START_FAILURE_RETRY_MS);
    }
  }

  private async closeBinding(binding: Binding): Promise<void> {
    await this.control(binding.bindingId);
    const cached = this.placements.get(binding.podUid);
    if (cached?.bindingId === binding.bindingId) cached.bindingId = undefined;
  }

  private async revokeBinding(binding: Binding): Promise<void> {
    if (!binding.completed)
      binding.expiresAtMs = Math.max(
        binding.expiresAtMs,
        Date.now() + (this.opts.completionGraceMs ?? COMPLETION_RETRY_MS)
      );
    binding.completed = true;
    await this.closeBinding(binding);
    binding.proxy = undefined;
  }

  private async attach(
    runId: string,
    proxy: SecretProxyExecution,
    runToken: string
  ): Promise<void> {
    const binding = this.get(runId);
    const expiry = platformTokenExpiry(runToken, binding);
    if (
      binding.completed ||
      proxy.runId !== runId ||
      proxy.attempt !== binding.attempt ||
      proxy.expiresAtMs > expiry ||
      proxy.expiresAtMs <= Date.now() ||
      proxy.allowedHosts.some((host) => !isSecretProxyHostname(host))
    )
      return denied();
    binding.proxy = proxy;
    binding.expiresAtMs = proxy.expiresAtMs;
    await this.put(binding, runToken);
    binding.runToken = runToken;
    this.get(runId);
  }

  async refresh(runId: string, runToken?: string): Promise<void> {
    if (runToken && (!this.ready || (!this.bindings.has(runId) && this.recoverable.has(runId))))
      return denied();
    if (!this.bindings.has(runId)) return;
    const binding = this.get(runId);
    if (binding.completed) return denied();
    if (!runToken) return;
    const expiresAtMs = platformTokenExpiry(runToken, binding);
    if (!binding.proxy) {
      binding.expiresAtMs = expiresAtMs;
      return;
    }
    await this.put({ ...binding, expiresAtMs }, runToken);
    binding.expiresAtMs = expiresAtMs;
    binding.runToken = runToken;
  }

  async complete(
    caller: SecretProxyCaller,
    operation: () => Promise<CompletionResponse>,
    attemptNumber?: number
  ): Promise<CompletionResponse> {
    if (this.stopped) return denied();
    if (!this.ready) await this.start();
    if (!this.ready) return denied();
    await this.finishRevocations(caller.runId);
    await this.recover(caller);
    const rebind = this.rebinds.get(caller.runId);
    if (
      rebind &&
      rebind.runnerId === caller.runnerId &&
      (attemptNumber === undefined || attemptNumber >= rebind.attempt)
    ) {
      if (rebind.busy) return denied();
      this.dropRebind(caller.runId);
    }
    const binding = this.bindings.get(caller.runId);
    if (!binding) return operation();
    if (!matchesCaller(binding, caller)) return denied();
    if (attemptNumber !== undefined && attemptNumber < binding.attempt) return operation();
    return this.completeBinding(binding, operation);
  }

  async revokeSuspending(runId: string, snapshotFriendlyId: string): Promise<void> {
    if (this.stopped) return denied();
    const rebind = this.rebinds.get(runId);
    if (rebind?.busy) return denied();
    // An unbound VM keeps its original cursor, so a later suspend cannot skip the history since.
    if (rebind) {
      rebind.ready = false;
      rebind.suspend = snapshotFriendlyId;
    }
    await this.finishRevocations(runId);
    const guests = this.recoverable.get(runId);
    for (const guestId of guests ?? []) {
      const allocation = await allocationForGuest(this.opts.socketPath, guestId);
      if (allocation.binding?.runId === runId) await this.control(allocation.bindingId);
      guests!.delete(guestId);
    }
    if (guests?.size === 0) this.recoverable.delete(runId);
    const binding = this.bindings.get(runId);
    if (!binding) return;
    if (binding.busy) return denied();
    if (binding.proxy)
      this.rebinds.set(runId, {
        trigger: "suspend",
        suspend: snapshotFriendlyId,
        since: snapshotFriendlyId,
        runnerId: binding.runnerId,
        attempt: binding.attempt,
        proxy: { ...binding.proxy, expiresAtMs: binding.expiresAtMs },
        runToken: binding.runToken,
        ready: false,
        busy: false,
      });
    binding.busy = true;
    try {
      await this.closeBinding(binding);
    } catch (error) {
      const pending = this.pendingRevocations.get(runId) ?? new Set<string>();
      pending.add(binding.bindingId);
      this.pendingRevocations.set(runId, pending);
      const cached = this.placements.get(binding.podUid);
      if (cached?.bindingId === binding.bindingId) cached.bindingId = undefined;
      throw error;
    } finally {
      binding.busy = false;
      if (this.bindings.get(runId) === binding) this.bindings.delete(runId);
    }
  }

  async activateContinue(
    caller: SecretProxyCaller,
    placement: SecretProxyPlacement,
    response: SecretProxyContinueResult
  ): Promise<void> {
    const { secretProxy, runToken, run } = response;
    const attempt = run.attemptNumber;
    if (!secretProxy || !runToken || !attempt || !caller.runnerId) return;
    try {
      await this.bindContinued(caller, placement, attempt, runToken, secretProxy);
    } catch (error) {
      if (!this.stopped)
        this.rebinds.set(caller.runId, {
          trigger: "continue",
          since: response.snapshot.friendlyId,
          runnerId: caller.runnerId,
          attempt,
          proxy: secretProxy,
          runToken,
          ready: true,
          busy: false,
        });
      throw error;
    }
  }

  /** A suspend's platform outcome: only an accepted one leaves the source VM unbound. */
  suspendSettled(runId: string, snapshotFriendlyId: string, accepted: boolean): void {
    const pending = this.rebinds.get(runId);
    if (!pending || pending.suspend !== snapshotFriendlyId) return;
    if (accepted) {
      this.rebinds.delete(runId);
      return;
    }
    pending.suspend = undefined;
    pending.ready = true;
  }

  /**
   * Call after a successful platform heartbeat from the VM. Binds only if, since the VM last held
   * authority, the attempt never left the process: no checkpoint and no state it could resume
   * elsewhere from. Never throws.
   */
  async rebindContinued(caller: SecretProxyCaller, heartbeatToken?: string): Promise<void> {
    const pending = this.rebinds.get(caller.runId);
    if (!pending?.ready || pending.busy || pending.runnerId !== caller.runnerId) return;
    if (
      !(heartbeatToken ?? pending.runToken) ||
      !this.opts.snapshotsSince ||
      !this.opts.latestExecution
    )
      return;
    pending.busy = true;
    try {
      const executions = await this.opts.snapshotsSince(caller, pending.since);
      // Read after the history: a replica may lag, so the history counts only if it reaches the
      // primary's latest snapshot.
      const latest = await this.opts.latestExecution(caller);
      const complete =
        latest.snapshot.friendlyId === pending.since ||
        executions.some(
          (execution) => execution.snapshot.friendlyId === latest.snapshot.friendlyId
        );
      if (!complete) return;
      if (
        executions.length >= MAX_SNAPSHOTS_SINCE ||
        executions.some(
          (execution) =>
            execution.checkpoint ||
            execution.run.attemptNumber !== pending.attempt ||
            !IN_PROCESS_STATUSES.has(execution.snapshot.executionStatus)
        )
      ) {
        this.dropRebind(caller.runId);
        return;
      }
      if (heartbeatToken) {
        const expiresAtMs = platformTokenExpiry(heartbeatToken, {
          runId: caller.runId,
          attempt: pending.attempt,
          environmentId: caller.claims?.environment_id ?? "",
          deploymentId: caller.claims?.deployment ?? "",
        });
        pending.runToken = heartbeatToken;
        pending.proxy = { ...pending.proxy, expiresAtMs };
      }
      await this.finishRevocations(caller.runId);
      const placement = await this.prepareStart(caller, { continuing: true });
      if (!placement) return;
      const cached = this.placements.get(placement.podUid);
      if (cached?.pinned) cached.boundAttempt ??= pending.attempt;
      await this.bindContinued(
        caller,
        placement,
        pending.attempt,
        pending.runToken!,
        pending.proxy
      );
      continuedBindings.inc({ trigger: pending.trigger, outcome: "bound" });
    } catch {
      // Retried on the next heartbeat until the authority expires.
    } finally {
      pending.busy = false;
    }
  }

  private dropRebind(runId: string): void {
    const pending = this.rebinds.get(runId);
    if (!pending) return;
    this.rebinds.delete(runId);
    if (pending.ready) continuedBindings.inc({ trigger: pending.trigger, outcome: "lost" });
  }

  private async bindContinued(
    caller: SecretProxyCaller,
    placement: SecretProxyPlacement,
    attempt: number,
    runToken: string,
    secretProxy: SecretProxyExecution
  ): Promise<void> {
    // `withStart` is keyed by this exact object, so it must not be copied.
    placement.continuing = true;
    try {
      await this.withStart(placement, () =>
        this.activateStart(caller, placement, {
          execution: {
            run: { id: caller.runId },
            attempt: { number: attempt },
            environment: { id: placement.environmentId },
            deployment: { id: placement.deploymentId },
          },
          secretProxy,
          envVars: { TRIGGER_RUN_TOKEN: runToken },
        })
      );
    } catch (error) {
      // Its credential write may have landed, so revoke it before the next attempt to bind.
      const failed = this.bindings.get(caller.runId);
      if (failed?.bindingId === placement.bindingId) {
        this.bindings.delete(caller.runId);
        const pending = this.pendingRevocations.get(caller.runId) ?? new Set<string>();
        pending.add(placement.bindingId);
        this.pendingRevocations.set(caller.runId, pending);
        await this.finishRevocations(caller.runId).catch(() => {});
      }
      throw error;
    }
  }

  async revokeRunner(
    runnerId: string,
    runnerUid: string,
    discovered?: SecretProxyAllocationBusyError["discovered"]
  ): Promise<void> {
    if (discovered) {
      const guests = this.recoverable.get(discovered.runId);
      guests?.delete(discovered.guestId);
      if (guests?.size === 0) this.recoverable.delete(discovered.runId);
      const pending = this.pendingRevocations.get(discovered.runId) ?? new Set<string>();
      pending.add(discovered.bindingId);
      this.pendingRevocations.set(discovered.runId, pending);
    }
    for (const start of this.starting.values()) {
      if (start.runnerId === runnerId && start.runnerUid === runnerUid)
        this.retiredStarts.add(start);
    }
    const cached = this.placements.get(this.runnerPlacements.get(runnerId) ?? "");
    if (cached?.runnerUid === runnerUid) this.forgetPlacement(cached);
    this.placementLookups.delete(runnerId);
    for (const [runId, pending] of this.rebinds)
      if (pending.runnerId === runnerId) this.rebinds.delete(runId);
    const revocations = [...this.bindings]
      .filter(([, binding]) => binding.runnerId === runnerId && binding.runnerUid === runnerUid)
      .map(async ([runId, binding]) => {
        binding.completed = true;
        binding.busy = true;
        try {
          await this.closeBinding(binding);
          if (this.bindings.get(runId) === binding) this.bindings.delete(runId);
        } finally {
          binding.busy = false;
        }
      });
    if (discovered) revocations.push(this.finishRevocations(discovered.runId));
    const failed = (await Promise.allSettled(revocations)).find(
      (result) => result.status === "rejected"
    );
    if (failed) throw failed.reason;
  }

  private async completeBinding(
    binding: Binding,
    operation: () => Promise<CompletionResponse>
  ): Promise<CompletionResponse> {
    return this.exclusive(
      binding.runId,
      async () => {
        if (this.bindings.get(binding.runId) !== binding) return denied();
        await this.revokeBinding(binding);
        const response = await operation();
        if (response.success && this.bindings.get(binding.runId) === binding)
          this.bindings.delete(binding.runId);
        return response;
      },
      binding.runnerId,
      true
    );
  }

  private get(runId: string): Binding {
    const binding = this.bindings.get(runId);
    if (!binding || binding.expiresAtMs <= Date.now() || this.stopped) return denied();
    return binding;
  }

  private put(binding: Binding, runToken: string): Promise<void> {
    return this.control(binding.bindingId, {
      allocationId: binding.allocationId,
      guestId: binding.guestId,
      sourceIp: binding.sourceIp,
      runId: binding.runId,
      attempt: binding.attempt,
      runToken,
      expiresAtMs: binding.expiresAtMs,
      allowedHosts: binding.proxy!.allowedHosts,
    });
  }

  private async control(bindingId: string, body?: object): Promise<void> {
    if (this.controlling >= MAX_IN_FLIGHT) {
      controlRequests.inc({ operation: body === undefined ? "revoke" : "bind", outcome: "error" });
      return denied();
    }
    this.controlling++;
    const pending = interceptorControl(this.opts.socketPath, bindingId, body);
    this.controls.add(pending);
    try {
      await pending;
    } finally {
      this.controlling--;
      this.controls.delete(pending);
    }
  }

  private async expire(): Promise<void> {
    if (!this.ready && !this.stopped && Date.now() >= this.nextControlRetryAt) await this.start();
    for (const runId of this.pendingRevocations.keys())
      await this.finishRevocations(runId).catch(() => {});
    for (const bindingId of this.failedStarts.keys()) await this.retryFailedStart(bindingId);
    for (const [runId, pending] of this.rebinds)
      if (pending.proxy.expiresAtMs <= Date.now()) this.dropRebind(runId);
    for (const [runId, binding] of this.bindings) {
      if (this.failedStarts.has(binding.bindingId)) continue;
      if (!binding.proxy && binding.expiresAtMs <= Date.now()) {
        this.bindings.delete(runId);
        continue;
      }
      if (binding.busy) continue;
      if (binding.expiresAtMs > Date.now()) continue;
      binding.busy = true;
      try {
        if (binding.proxy) await this.closeBinding(binding);
      } catch {
        const cached = this.placements.get(binding.podUid);
        if (cached?.bindingId === binding.bindingId) this.forgetPlacement(cached);
      } finally {
        if (this.bindings.get(runId) === binding) this.bindings.delete(runId);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.readiness.set(0);
    clearInterval(this.cleanup);
    await Promise.allSettled([...this.controls]);
    const bindingIds = [...this.failedStarts]
      .filter(([, failure]) => failure.revoke)
      .map(([bindingId]) => bindingId);
    for (let i = 0; i < bindingIds.length; i += MAX_IN_FLIGHT) {
      await Promise.allSettled(
        bindingIds.slice(i, i + MAX_IN_FLIGHT).map((bindingId) => this.control(bindingId))
      );
    }
    this.bindings.clear();
    this.failedStarts.clear();
    this.placements.clear();
    this.runnerPlacements.clear();
    this.placementLookups.clear();
    this.recoverable.clear();
    this.pendingRevocations.clear();
    this.rebinds.clear();
  }
}
