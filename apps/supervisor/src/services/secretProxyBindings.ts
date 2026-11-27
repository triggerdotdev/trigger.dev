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
import { setTimeout as sleep } from "node:timers/promises";
import pLimit from "p-limit";
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
/** How long a control call waits for a restarting interceptor (measured gap: about 2s). */
const INTERCEPTOR_RESTART_BUDGET_MS = 15_000;
const INITIAL_RESTART_RETRY_MS = 100;
const MAX_RESTART_RETRY_MS = 1_000;
/** Connect errors: the request never reached an interceptor, so repeating it cannot apply it twice. */
const NOT_LISTENING_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

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
    restrictedNetwork: z.boolean().optional(),
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
  attached: z.boolean(),
  pod: z.object({ uid: z.string(), ip: z.string() }).nullish(),
  runId: z.string().min(1),
  attempt: z.number().int().nonnegative().safe(),
  bindingId: z.string().min(1),
  empty: z.boolean(),
  hasBeenBound: z.boolean(),
  /** Absent from interceptors that cannot restrict, which then never serve a restricted Runner. */
  restrictedNetwork: z.boolean().optional(),
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
  /** The trusted Runner asked for a restricted VM, which its interceptor and CNI enforce. */
  restrictedNetwork?: boolean;
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
  | "restrictedNetwork"
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

class InterceptorUnavailableError extends Error {
  constructor(readonly notListening: boolean) {
    super("Secret proxy control unavailable");
  }
}

function controlUnavailable(error?: unknown): InterceptorUnavailableError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new InterceptorUnavailableError(code !== undefined && NOT_LISTENING_CODES.has(code));
}

function interceptorNotListening(error: unknown): boolean {
  return error instanceof InterceptorUnavailableError && error.notListening;
}

function pinnedKey(placement: Pick<Identity, "allocationId" | "runnerUid">): string {
  return `${placement.allocationId}/${placement.runnerUid}`;
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

function isNetworkHostPattern(host: string): boolean {
  return isSecretProxyHostname(host.startsWith("*.") ? host.slice(2) : host);
}

function validProxyHosts(proxy: Pick<SecretProxyExecution, "allowedHosts" | "network">): boolean {
  return (
    proxy.allowedHosts.every(isSecretProxyHostname) &&
    (proxy.network?.allow.every(isNetworkHostPattern) ?? true) &&
    (proxy.allowedHosts.length > 0 || proxy.network !== undefined)
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

function hasPodField(pod: V1Pod, name: string, path: string): boolean {
  const entries = pod.spec?.containers[0]?.env?.filter((e) => e.name === name);
  return entries?.length === 1 && entries[0]?.valueFrom?.fieldRef?.fieldPath === path;
}

type CachedPlacement = Omit<ReturnType<typeof trustedSecretProxyIdentity>, "publishedGuestId"> & {
  guestId: string;
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
): Omit<Identity, "allocationId" | "bindingId" | "runId" | "attempt" | "guestId"> & {
  publishedGuestId?: string;
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
    pod.spec?.containers.length !== 1 ||
    pod.spec.restartPolicy !== "Never" ||
    !hasPodField(pod, "TRIGGER_POD_UID", "metadata.uid") ||
    !hasPodField(pod, "TRIGGER_POD_IP", "status.podIP") ||
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
  const status = pod.status?.containerStatuses?.find((s) => s.name === container);
  const publishedGuestId = status?.containerID?.match(/^containerd:\/\/([a-zA-Z0-9_-]+)$/)?.[1];
  if (
    (pod.status?.podIP && sourceIp(pod.status.podIP) !== ip) ||
    (status?.containerID && !publishedGuestId) ||
    status?.state?.terminated ||
    pod.status?.phase === "Failed" ||
    pod.status?.phase === "Succeeded"
  )
    return denied();
  return {
    publishedGuestId,
    podUid: pod.metadata.uid,
    sourceIp: ip,
    bootstrapRunId: runner.spec.bootstrap.runFriendlyID,
    bootstrapAttempt: attempt,
    singleUseAttempt: runner.spec.singleUse && !runner.spec.restore ? attempt : undefined,
    pinned: !!runner.spec.singleUse,
    restrictedNetwork: !!runner.spec.restrictedNetwork,
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
    const socket = await lstat(socketPath).catch((error) => {
      throw controlUnavailable(error);
    });
    if (
      !socket.isSocket() ||
      (socket.mode & 0o077) !== 0 ||
      (socket.uid !== 0 && socket.uid !== process.getuid?.())
    )
      return denied();
    const result = await new Promise<string>((resolve, reject) => {
      const fail = (error?: Error) => reject(controlUnavailable(error));
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
          res.on("error", () => fail());
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

async function lookupAllocation(socketPath: string, path: string) {
  try {
    return Allocation.parse(
      JSON.parse(await interceptorRequest(socketPath, `/allocations/${path}`, "GET"))
    );
  } catch (error) {
    if (interceptorNotListening(error)) throw error;
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
  /**
   * The attempt a pinned VM was bound to, by allocation ID and runner UID. The interceptor keeps a
   * VM's binding history but not its attempt, so a placement re-read after a failed start needs it.
   */
  private readonly pinnedAttempts = new Map<string, number>();
  private readonly placementLookups = new Map<
    string,
    { owner: SecretProxyCaller; promise: Promise<CachedPlacement | undefined> }
  >();
  private readonly recoverable = new Map<string, Set<string>>();
  private readonly pendingRevocations = new Map<string, Set<string>>();
  private readonly rebinds = new Map<string, PendingRebind>();
  private discovery?: Promise<void>;
  private readonly lookups = pLimit(MAX_IN_FLIGHT);
  private controlling = 0;
  private readonly controls = new Set<Promise<void>>();
  private sweeping = false;
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

  restrictsNetwork(runId: string): boolean {
    return !!this.bindings.get(runId)?.restrictedNetwork;
  }

  private async finishRevocations(runId: string, waitForRestart = true): Promise<void> {
    const bindingIds = this.pendingRevocations.get(runId);
    if (!bindingIds) return;
    for (const bindingId of bindingIds) {
      await this.control(bindingId, undefined, waitForRestart);
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
    if (placement.pinned && placement.boundAttempt !== undefined) {
      if (this.pinnedAttempts.size >= MAX_PLACEMENTS)
        this.pinnedAttempts.delete(this.pinnedAttempts.keys().next().value!);
      this.pinnedAttempts.set(pinnedKey(placement), placement.boundAttempt);
    }
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
    const { publishedGuestId, ...placement } = trustedSecretProxyIdentity(
      runner.value,
      pod.value,
      caller,
      this.opts.nodeName,
      this.opts.namespace
    );
    const allocation = await lookupAllocation(
      this.opts.socketPath,
      `by-pod/${encodeURIComponent(placement.podUid)}`
    );
    if (
      allocation.runId !== placement.bootstrapRunId ||
      allocation.attempt !== placement.bootstrapAttempt ||
      !allocation.attached ||
      allocation.pod?.uid !== placement.podUid ||
      sourceIp(allocation.pod.ip) !== placement.sourceIp ||
      (publishedGuestId && allocation.guestId !== publishedGuestId) ||
      !!allocation.restrictedNetwork !== !!placement.restrictedNetwork
    )
      return denied();
    if (!recovering) await this.requireEmpty(allocation, placement);
    return {
      ...placement,
      guestId: allocation.guestId,
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
    if (placement.pinned && placement.hasBeenBound)
      placement.boundAttempt ??= this.pinnedAttempts.get(pinnedKey(placement));
    this.pinnedAttempts.delete(pinnedKey(placement));
    this.placements.set(placement.podUid, placement);
    this.runnerPlacements.set(placement.runnerId, placement.podUid);
  }

  private async recover(caller: SecretProxyCaller): Promise<void> {
    const guests = this.recoverable.get(caller.runId);
    if (!guests || this.bindings.has(caller.runId)) return;
    if (this.stopped || !caller.runnerId) return denied();
    const found = await this.lookupWithSlot(caller, true);
    if (this.stopped || !guests.has(found.guestId)) return denied();
    const { binding: recovered, ...placement } = found;
    if (recovered && recovered.runId === caller.runId) {
      if (
        recovered.bindingId !== placement.bindingId ||
        recovered.sourceIp !== placement.sourceIp ||
        !validProxyHosts(recovered)
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
   * Repeats `operation` while the interceptor is not listening, as between an old process exiting
   * and its replacement binding the control socket. Waits outside any slot the operation takes.
   */
  private async whileInterceptorRestarts<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = performance.now() + INTERCEPTOR_RESTART_BUDGET_MS;
    for (let delayMs = INITIAL_RESTART_RETRY_MS; ;) {
      try {
        return await operation();
      } catch (error) {
        if (!interceptorNotListening(error) || performance.now() + delayMs >= deadline) throw error;
        await sleep(delayMs);
        if (this.stopped) throw error;
        delayMs = Math.min(delayMs * 2, MAX_RESTART_RETRY_MS);
      }
    }
  }

  private lookupWithSlot(caller: SecretProxyCaller, recovering = false) {
    return this.whileInterceptorRestarts(() => {
      if (this.lookups.pendingCount >= MAX_PLACEMENTS) return denied();
      const deadline = performance.now() + KUBERNETES_TIMEOUT_MS;
      const read = this.lookups(() =>
        this.stopped || performance.now() >= deadline
          ? denied()
          : this.readPlacement(caller, recovering)
      );
      return withTimeout(read, KUBERNETES_TIMEOUT_MS, "Secret proxy identity");
    });
  }

  async prepareStart(
    caller: SecretProxyCaller,
    { continuing = false } = {}
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
    let allocation: z.infer<typeof Allocation> | undefined;
    try {
      allocation = cached && (await this.cachedAllocation(cached));
    } catch {
      // The interceptor stayed down for the whole restart budget: keep the cached placement and
      // don't wait a second budget on a fresh lookup.
      return;
    }
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
        pending = {
          owner: caller,
          promise: this.lookupWithSlot(caller)
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
              if (error instanceof SecretProxyAllocationBusyError) throw error;
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
        const owner = pending.owner;
        if (
          owner.runId !== caller.runId ||
          sourceIp(owner.sourceIp) !== sourceIp(caller.sourceIp) ||
          owner.claims?.environment_id !== caller.claims.environment_id ||
          owner.claims?.deployment !== caller.claims.deployment
        )
          return;
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
      const allocation = await this.whileInterceptorRestarts(() =>
        lookupAllocation(this.opts.socketPath, encodeURIComponent(cached.guestId))
      );
      if (
        !allocation.attached ||
        allocation.allocationId !== cached.allocationId ||
        allocation.runId !== cached.bootstrapRunId ||
        allocation.attempt !== cached.bootstrapAttempt ||
        !!allocation.restrictedNetwork !== !!cached.restrictedNetwork
      )
        return;
      cached.hasBeenBound ||= allocation.hasBeenBound;
      return allocation;
    } catch (error) {
      if (interceptorNotListening(error)) throw error;
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
    // Runs inside a placement lookup slot: an interceptor restart is waited out around that slot.
    await this.control(allocation.bindingId, undefined, false);
    const current = await lookupAllocation(
      this.opts.socketPath,
      encodeURIComponent(allocation.guestId)
    );
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
      // A restricted VM serves only restricted executions: anything else would run without internet.
      (placement.restrictedNetwork && !response.secretProxy?.network) ||
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
      await this.whileInterceptorRestarts(() =>
        interceptorRequest(
          this.opts.socketPath,
          `/allocations/${encodeURIComponent(binding.allocationId)}/binding`,
          "PUT",
          { bindingId: binding.bindingId }
        )
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

  async retryFailedStart(bindingId: string, waitForRestart = true): Promise<void> {
    const failure = this.failedStarts.get(bindingId);
    if (!failure || failure.busy || this.stopped || Date.now() < failure.nextRetryAtMs) return;
    failure.busy = true;
    const binding = this.bindings.get(failure.runId);
    const recover = async () => {
      if (binding?.bindingId === bindingId) await this.revokeBinding(binding, waitForRestart);
      else if (failure.revoke) await this.control(bindingId, undefined, waitForRestart);

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

  private async closeBinding(binding: Binding, waitForRestart = true): Promise<void> {
    await this.control(binding.bindingId, undefined, waitForRestart);
    const cached = this.placements.get(binding.podUid);
    if (cached?.bindingId === binding.bindingId) cached.bindingId = undefined;
  }

  private async revokeBinding(binding: Binding, waitForRestart = true): Promise<void> {
    if (!binding.completed)
      binding.expiresAtMs = Math.max(
        binding.expiresAtMs,
        Date.now() + (this.opts.completionGraceMs ?? COMPLETION_RETRY_MS)
      );
    binding.completed = true;
    await this.closeBinding(binding, waitForRestart);
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
      !validProxyHosts(proxy) ||
      // Only a VM created restricted can serve a restricted execution, and only that.
      !!proxy.network !== !!binding.restrictedNetwork
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
      const allocation = await lookupAllocation(this.opts.socketPath, encodeURIComponent(guestId));
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
      ...(binding.proxy!.network ? { network: binding.proxy!.network } : {}),
    });
  }

  private control(bindingId: string, body?: object, waitForRestart = true): Promise<void> {
    const attempt = async () => {
      if (this.controlling >= MAX_IN_FLIGHT) {
        controlRequests.inc({
          operation: body === undefined ? "revoke" : "bind",
          outcome: "error",
        });
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
    };
    return waitForRestart ? this.whileInterceptorRestarts(attempt) : attempt();
  }

  private async expire(): Promise<void> {
    // Control calls can now wait out an interceptor restart, so a sweep may outlast its interval.
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweep();
    } finally {
      this.sweeping = false;
    }
  }

  // Single attempts only: the sweep reruns every interval, so it never waits out a restart.
  private async sweep(): Promise<void> {
    if (!this.ready && !this.stopped && Date.now() >= this.nextControlRetryAt) await this.start();
    for (const runId of this.pendingRevocations.keys())
      await this.finishRevocations(runId, false).catch(() => {});
    for (const bindingId of this.failedStarts.keys()) await this.retryFailedStart(bindingId, false);
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
        if (binding.proxy) await this.closeBinding(binding, false);
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
