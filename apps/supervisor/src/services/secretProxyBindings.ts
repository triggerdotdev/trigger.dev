import type { V1Pod } from "@kubernetes/client-node";
import type { DequeuedMessage, WorkloadDeploymentTokenClaims } from "@trigger.dev/core/v3";
import type {
  SecretProxyExecution,
  SupervisorHttpClient,
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
import type { RestoreOutcomeReport } from "../workloadManager/runCrd.js";
import type { RunReleaser } from "./runReleases.js";

const CONTROL_TIMEOUT_MS = 2_000;
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

const controlRequests = new Counter({
  name: "supervisor_secret_proxy_control_requests_total",
  help: "Local interceptor control calls by bounded operation and outcome",
  labelNames: ["operation", "outcome"],
  registers: [register],
});
for (const operation of ["reset", "lookup", "bind", "revoke"]) {
  for (const outcome of ["success", "error"]) controlRequests.inc({ operation, outcome }, 0);
}

function readinessMetric(): Gauge {
  const existing = register.getSingleMetric("supervisor_secret_proxy_ready");
  if (existing instanceof Gauge) return existing;
  return new Gauge({
    name: "supervisor_secret_proxy_ready",
    help: "Proxy supervisor startup reset succeeded; not per-allocation connectivity",
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
  attempt: z.number().int().positive().safe(),
  bindingId: z.string().min(1),
  empty: z.boolean(),
  hasBeenBound: z.boolean(),
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
> & { isWarmStart: boolean };

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

type Binding = Identity & {
  expiresAtMs: number;
  busy: boolean;
  completed: boolean;
  proxy?: SecretProxyExecution;
};

export class SecretProxyAllocationBusyError extends Error {
  constructor(readonly runner: Pick<Identity, "runnerId" | "runnerUid">) {
    super("Secret proxy allocation is busy");
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

type CachedPlacement = ReturnType<typeof trustedSecretProxyIdentity> & {
  allocationId: string;
  hasBeenBound: boolean;
  bindingId?: string;
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
  const attempt =
    caller.runnerId && attemptOfRunnerId(caller.runnerId, runner.spec.bootstrap.runFriendlyID);
  const container = pod.spec?.containers[0]?.name;
  const status = pod.status?.containerStatuses?.find((s) => s.name === container);
  const guestId = status?.containerID?.match(/^containerd:\/\/([a-zA-Z0-9_-]+)$/)?.[1];
  if (
    !caller.claims ||
    !ip ||
    !attempt ||
    !guestId ||
    !pod.metadata?.uid ||
    runner.metadata.deletionTimestamp ||
    pod.metadata.deletionTimestamp ||
    runner.metadata.namespace !== namespace ||
    pod.metadata.namespace !== namespace ||
    runner.metadata.name !== caller.runnerId ||
    pod.metadata.name !== caller.runnerId ||
    runner.spec.restore ||
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
    pod.spec.hostNetwork ||
    sourceIp(pod.status?.podIP) !== ip ||
    !status?.state?.running
  )
    return denied();
  return {
    guestId,
    podUid: pod.metadata.uid,
    sourceIp: ip,
    bootstrapRunId: runner.spec.bootstrap.runFriendlyID,
    bootstrapAttempt: attempt,
    singleUseAttempt: runner.spec.singleUse ? attempt : undefined,
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
            if (bytes > 16_384) req.destroy(new Error("Control response too large"));
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

export async function reportSecretProxyRestoreRefusal(
  options: { interceptorSocket?: string; checkpoint?: DequeuedMessage["checkpoint"] },
  deps: {
    report: RestoreOutcomeReport;
    release: () => ReturnType<RunReleaser["release"]>;
  }
): Promise<
  | false
  | { result: "ok" | "conflict" }
  | { result: "error"; error: string; releaseResult: Awaited<ReturnType<RunReleaser["release"]>> }
> {
  if (!options.interceptorSocket || !options.checkpoint) return false;
  const reported = await deps.report({
    outcome: "fail",
    reason: "SecretProxyCheckpointUnsupported",
    message: "The secret proxy lab lane does not support checkpoint restores",
  });
  if (reported.success) return { result: "ok" };
  if (reported.statusCode === 409) return { result: "conflict" };
  return { result: "error", error: reported.error, releaseResult: await deps.release() };
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
    }
  ) {
    this.readiness.set(0);
    this.cleanup = setInterval(() => void this.expire(), CLEANUP_INTERVAL_MS);
    this.cleanup.unref();
  }

  async start(): Promise<void> {
    this.ready = false;
    this.placements.clear();
    this.runnerPlacements.clear();
    this.placementLookups.clear();
    try {
      await interceptorControl(this.opts.socketPath);
      this.ready = !this.stopped;
      this.readiness.set(this.ready ? 1 : 0);
    } catch {
      this.readiness.set(0);
      this.nextControlRetryAt = Date.now() + this.controlRetryMs;
      this.controlRetryMs = Math.min(this.controlRetryMs * 2, MAX_CONTROL_RETRY_MS);
    }
  }

  tracks(runId: string): boolean {
    return this.bindings.has(runId);
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

  private async readPlacement(caller: SecretProxyCaller): Promise<CachedPlacement> {
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
    await this.requireEmpty(allocation, placement);
    return {
      ...placement,
      allocationId: allocation.allocationId,
      hasBeenBound: allocation.hasBeenBound,
    };
  }

  async prepareStart(caller: SecretProxyCaller): Promise<SecretProxyPlacement | undefined> {
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
        if (this.verifying >= MAX_IN_FLIGHT) return;
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
              const previous = this.placements.get(
                this.runnerPlacements.get(placement.runnerId) ?? ""
              );
              if (previous) this.forgetPlacement(previous);
              if (this.placements.size >= MAX_PLACEMENTS)
                this.forgetPlacement(this.placements.values().next().value!);
              this.placements.set(placement.podUid, placement);
              this.runnerPlacements.set(placement.runnerId, placement.podUid);
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
      cached = await pending.promise;
    }
    if (
      !cached ||
      this.stopped ||
      !this.ready ||
      this.placements.get(cached.podUid) !== cached ||
      !matchesPlacementCaller(cached, caller) ||
      (cached.singleUseAttempt !== undefined && caller.runId !== cached.bootstrapRunId)
    )
      return;
    if (cached.bindingId || (cached.singleUseAttempt !== undefined && cached.hasBeenBound))
      throw new SecretProxyAllocationBusyError(cached);
    this.placements.delete(cached.podUid);
    this.placements.set(cached.podUid, cached);
    return {
      ...cached,
      bindingId: randomUUID(),
      isWarmStart: caller.runId !== cached.bootstrapRunId || cached.hasBeenBound,
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
      if (cached.bindingId || (cached.singleUseAttempt !== undefined && cached.hasBeenBound))
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
    const binding = this.bindings.get(caller.runId);
    if (
      !binding ||
      !matchesCaller(binding, caller) ||
      (!completing && (binding.completed || binding.expiresAtMs <= Date.now()))
    )
      return denied();
  }

  /** Only call with a successful response from the authenticated platform connection. */
  async activateStart(
    caller: SecretProxyCaller,
    placement: SecretProxyPlacement,
    response: SecretProxyStartResult
  ): Promise<void> {
    const { execution } = response;
    const protectedStart = response.secretProxy !== undefined;
    const cached = this.currentPlacement(placement);
    if (
      this.stopped ||
      !this.ready ||
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
    this.get(runId);
  }

  async refresh(runId: string, runToken?: string): Promise<void> {
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
  }

  async complete(
    caller: SecretProxyCaller,
    operation: () => Promise<CompletionResponse>,
    attemptNumber?: number
  ): Promise<CompletionResponse> {
    if (this.stopped) return denied();
    const binding = this.bindings.get(caller.runId);
    if (!binding) return operation();
    if (!matchesCaller(binding, caller)) return denied();
    if (attemptNumber !== undefined && attemptNumber < binding.attempt) return operation();
    return this.completeBinding(binding, operation);
  }

  async revokeRunner(runnerId: string, runnerUid: string): Promise<void> {
    for (const start of this.starting.values()) {
      if (start.runnerId === runnerId && start.runnerUid === runnerUid)
        this.retiredStarts.add(start);
    }
    const cached = this.placements.get(this.runnerPlacements.get(runnerId) ?? "");
    if (cached?.runnerUid === runnerUid) this.forgetPlacement(cached);
    this.placementLookups.delete(runnerId);
    for (const [runId, binding] of this.bindings) {
      if (binding.runnerId !== runnerId || binding.runnerUid !== runnerUid) continue;
      binding.completed = true;
      binding.busy = true;
      try {
        await this.closeBinding(binding);
        if (this.bindings.get(runId) === binding) this.bindings.delete(runId);
      } finally {
        binding.busy = false;
      }
    }
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
    for (const bindingId of this.failedStarts.keys()) await this.retryFailedStart(bindingId);
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
    const bindingIds = [
      ...new Set([
        ...[...this.bindings.values()]
          .filter((binding) => binding.proxy)
          .map((binding) => binding.bindingId),
        ...[...this.failedStarts]
          .filter(([, failure]) => failure.revoke)
          .map(([bindingId]) => bindingId),
      ]),
    ];
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
  }
}
