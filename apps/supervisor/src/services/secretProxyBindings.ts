import type { V1Pod } from "@kubernetes/client-node";
import type { DequeuedMessage, WorkloadDeploymentTokenClaims } from "@trigger.dev/core/v3";
import type {
  SecretProxyExecution,
  SupervisorHttpClient,
} from "@trigger.dev/core/v3/runEngineWorker";
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
const MAX_IN_FLIGHT = 16;
const UNBOUND_CACHE_MS = 60_000;
const CLEANUP_INTERVAL_MS = 10_000;
const COMPLETION_RETRY_MS = 5 * 60_000;
const MAX_COMPLETION_RETRIES = 1_024;
const INITIAL_CONTROL_RETRY_MS = CLEANUP_INTERVAL_MS;
const MAX_CONTROL_RETRY_MS = 60_000;

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
});

type Identity = {
  allocationId: string;
  bindingId: string;
  guestId: string;
  sourceIp: string;
  runId: string;
  attempt: number;
  runnerId: string;
  environmentId: string;
  deploymentId: string;
};

type Binding = Identity & {
  expiresAtMs: number;
  busy: boolean;
  started: boolean;
  completed: boolean;
  completionSnapshotId?: string;
  proxy?: SecretProxyExecution;
  failedStart?: {
    caller: SecretProxyCaller;
    snapshotId: string;
    complete: () => Promise<CompletionResponse>;
  };
};

type CompletionResponse = Awaited<ReturnType<SupervisorHttpClient["completeRunAttempt"]>>;
type Completed = Pick<
  Identity,
  "runId" | "runnerId" | "sourceIp" | "environmentId" | "deploymentId"
> & {
  snapshotId: string;
  expiresAtMs: number;
  response: Extract<CompletionResponse, { success: true }>;
};

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

function matchesCaller(identity: Completed | Identity, caller: SecretProxyCaller): boolean {
  return (
    identity.runId === caller.runId &&
    identity.runnerId === caller.runnerId &&
    identity.sourceIp === sourceIp(caller.sourceIp) &&
    identity.environmentId === caller.claims?.environment_id &&
    identity.deploymentId === caller.claims?.deployment
  );
}

function trustedSecretProxyIdentity(
  runnerObject: unknown,
  pod: V1Pod,
  caller: SecretProxyCaller,
  nodeName: string,
  namespace: string
): Omit<Identity, "allocationId" | "bindingId"> {
  const parsed = Runner.safeParse(runnerObject);
  if (!parsed.success) return denied();
  const runner = parsed.data;
  const ip = sourceIp(caller.sourceIp);
  const attempt = caller.runnerId && attemptOfRunnerId(caller.runnerId, caller.runId);
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
    runner.spec.bootstrap.runFriendlyID !== caller.runId ||
    runner.spec.restore ||
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
    sourceIp: ip,
    runId: caller.runId,
    attempt,
    runnerId: runner.metadata.name,
    environmentId: caller.claims.environment_id,
    deploymentId: caller.claims.deployment,
  };
}

/** Only call with a token received over the authenticated supervisor/platform connection. */
function platformTokenExpiry(
  token: string,
  identity: Pick<Identity, "runId" | "attempt" | "environmentId">
): number {
  try {
    if (token.length > 32_768 || token.split(".").length !== 3) return denied();
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    if (
      claims.run_id !== identity.runId ||
      claims.attempt !== identity.attempt ||
      claims.environment_id !== identity.environmentId ||
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
  // A checkpoint can predate enrollment and still contain plaintext.
  const reported = await deps.report({
    outcome: "fail",
    reason: "SecretProxyCheckpointUnsupported",
    message: "The secret proxy lab lane does not support checkpoint restores",
  });
  if (reported.success) return { result: "ok" };
  if (reported.statusCode === 409) return { result: "conflict" };
  // Release is snapshot-guarded and uses the existing bounded dequeue retry policy.
  return { result: "error", error: reported.error, releaseResult: await deps.release() };
}

export class SecretProxyBindings {
  private readonly bindings = new Map<string, Binding>();
  private readonly completed = new Map<string, Completed>();
  private reserved = 0;
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
      k8s: Pick<K8sApi, "core" | "custom">;
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
    // Lab-only: exactly one supervisor must exclusively own this socket and be its only registrar.
    // Reset closes all existing contexts, including those awaiting their first binding.
    try {
      await interceptorControl(this.opts.socketPath);
      this.ready = !this.stopped;
      this.readiness.set(this.ready ? 1 : 0);
    } catch {
      this.readiness.set(0);
      // Ordinary runs must remain available while proxy startup is retried.
      this.nextControlRetryAt = Date.now() + this.controlRetryMs;
      this.controlRetryMs = Math.min(this.controlRetryMs * 2, MAX_CONTROL_RETRY_MS);
    }
  }

  tracks(runId: string, runnerId?: string): boolean {
    return this.bindings.has(runId) || (!!runnerId && this.completed.has(runnerId));
  }

  async prepareStart(caller: SecretProxyCaller, isWarmStart: boolean): Promise<boolean> {
    if (!this.ready || isWarmStart) return false;
    try {
      await this.authorize(caller, true);
      return true;
    } catch {
      // An unavailable proxy must not prevent ordinary attempts from starting.
      return false;
    }
  }

  async authorize(
    caller: SecretProxyCaller,
    fresh = false,
    completionSnapshotId?: string
  ): Promise<void> {
    if (this.stopped || !caller.claims || !caller.runnerId || !sourceIp(caller.sourceIp))
      return denied();
    const completed = this.getCompleted(caller);
    if (completed) {
      if (completed.snapshotId !== completionSnapshotId) return denied();
      return;
    }
    const cached = this.bindings.get(caller.runId);
    if (cached) {
      if (
        cached.expiresAtMs <= Date.now() ||
        !matchesCaller(cached, caller) ||
        (cached.completed && !completionSnapshotId) ||
        (cached.completionSnapshotId && cached.completionSnapshotId !== completionSnapshotId)
      )
        return denied();
      if (!fresh) return;
    }
    if (
      (!cached && this.bindings.size + this.reserved >= MAX_BINDINGS) ||
      this.verifying >= MAX_IN_FLIGHT
    )
      return denied();
    if (!cached) this.reserved++;
    this.verifying++;
    // The generated Kubernetes client cannot cancel. Keep admission occupied until the
    // actual requests settle, even if the caller has already timed out.
    const read = (async () => {
      const runner = await this.opts.k8s.custom.getNamespacedCustomObject({
        group: "compute.trigger.dev",
        version: "v1alpha1",
        plural: "runners",
        namespace: this.opts.namespace,
        name: caller.runnerId!,
      });
      const pod = await this.opts.k8s.core.readNamespacedPod({
        namespace: this.opts.namespace,
        name: caller.runnerId!,
      });
      const placement = trustedSecretProxyIdentity(
        runner,
        pod,
        caller,
        this.opts.nodeName,
        this.opts.namespace
      );
      const allocation = await allocationForGuest(this.opts.socketPath, placement.guestId);
      if (
        allocation.guestId !== placement.guestId ||
        allocation.runId !== placement.runId ||
        allocation.attempt !== placement.attempt
      )
        return denied();
      return {
        ...placement,
        bindingId: allocation.allocationId,
        allocationId: allocation.allocationId,
      };
    })().finally(() => this.verifying--);
    try {
      const identity = await withTimeout(
        read,
        KUBERNETES_TIMEOUT_MS,
        "Secret proxy identity"
      ).catch(() => denied());
      if (this.stopped || this.getCompleted(caller)) return denied();
      const existing = this.bindings.get(caller.runId);
      if (cached && existing !== cached) return denied();
      if (existing) {
        if (
          existing.bindingId !== identity.bindingId ||
          existing.allocationId !== identity.allocationId ||
          !matchesCaller(existing, caller)
        )
          return denied();
        return;
      }
      this.bindings.set(caller.runId, {
        ...identity,
        expiresAtMs: Date.now() + UNBOUND_CACHE_MS,
        busy: false,
        started: false,
        completed: false,
      });
    } finally {
      // A timed-out Kubernetes read still owns its admission reservation until it settles.
      if (!cached)
        void read.then(
          () => this.reserved--,
          () => this.reserved--
        );
    }
  }

  async exclusive<T>(
    runId: string,
    operation: () => Promise<T>,
    runnerId: string | undefined,
    completing = false
  ): Promise<T> {
    if (!this.bindings.has(runId)) return operation();
    const binding = this.get(runId);
    if (binding.busy || binding.runnerId !== runnerId || (binding.completed && !completing))
      return denied();
    binding.busy = true;
    try {
      return await operation();
    } finally {
      binding.busy = false;
    }
  }

  beginStart(runId: string): void {
    const binding = this.get(runId);
    if (binding.started || binding.completed) return denied();
    binding.started = true;
  }

  withoutProxy(runId: string, runnerId: string | undefined): void {
    const binding = this.bindings.get(runId);
    if (binding && binding.runnerId === runnerId && !binding.proxy && !binding.failedStart)
      this.bindings.delete(runId);
  }

  async failStart(
    caller: SecretProxyCaller,
    snapshotId: string,
    operation: () => Promise<CompletionResponse>
  ): Promise<void> {
    const binding = this.bindings.get(caller.runId);
    if (!binding || !matchesCaller(binding, caller)) {
      await operation();
      return;
    }
    binding.failedStart = { caller, snapshotId, complete: operation };
  }

  async retryFailedStart(runId: string): Promise<void> {
    const failure = this.bindings.get(runId)?.failedStart;
    if (!failure) return;
    try {
      await this.complete(failure.caller, failure.snapshotId, failure.complete);
    } catch {
      // The cleanup sweep retries without exposing placeholders to the runner.
    }
  }

  async attach(runId: string, proxy: SecretProxyExecution, runToken: string): Promise<void> {
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
    // Remember uncertain registrations too, so expiry/shutdown will revoke them.
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
    // A restarted supervisor cannot rebuild a binding from anything the guest sends.
    if (!binding.started) return denied();
    const expiresAtMs = platformTokenExpiry(runToken, binding);
    if (!binding.proxy) {
      binding.expiresAtMs = expiresAtMs;
      return;
    }
    await this.put({ ...binding, expiresAtMs }, runToken);
    binding.expiresAtMs = expiresAtMs;
  }

  async detach(runId: string): Promise<void> {
    const binding = this.get(runId);
    if (!binding.completed)
      binding.expiresAtMs = Math.max(
        binding.expiresAtMs,
        Date.now() + (this.opts.completionGraceMs ?? COMPLETION_RETRY_MS)
      );
    binding.completed = true;
    // After restart, absence of local start state does not prove there is no node binding.
    if (!binding.started) return denied();
    if (!binding.proxy) return;
    await this.control(binding.bindingId);
    binding.proxy = undefined;
  }

  async complete(
    caller: SecretProxyCaller,
    snapshotId: string,
    operation: () => Promise<CompletionResponse>
  ): Promise<CompletionResponse> {
    if (this.stopped) return denied();
    const completed = this.getCompleted(caller);
    if (completed) {
      if (completed.snapshotId !== snapshotId) return denied();
      return completed.response;
    }
    if (!this.bindings.has(caller.runId)) return operation();
    return this.exclusive(
      caller.runId,
      async () => {
        const binding = this.get(caller.runId);
        if (!matchesCaller(binding, caller)) return denied();
        if (binding.completionSnapshotId && binding.completionSnapshotId !== snapshotId)
          return denied();
        binding.completionSnapshotId = snapshotId;
        await this.detach(caller.runId);
        const response = await operation();
        if (response.success && !this.stopped) {
          this.completed.set(binding.runnerId, {
            runId: binding.runId,
            runnerId: binding.runnerId,
            sourceIp: binding.sourceIp,
            environmentId: binding.environmentId,
            deploymentId: binding.deploymentId,
            snapshotId,
            expiresAtMs: Date.now() + COMPLETION_RETRY_MS,
            response,
          });
          if (this.completed.size > MAX_COMPLETION_RETRIES)
            this.completed.delete(this.completed.keys().next().value!);
          if (this.bindings.get(caller.runId) === binding) this.bindings.delete(caller.runId);
        }
        return response;
      },
      caller.runnerId,
      true
    );
  }

  private getCompleted(caller: SecretProxyCaller): Completed | undefined {
    const completed = caller.runnerId ? this.completed.get(caller.runnerId) : undefined;
    if (!completed) return;
    if (completed.expiresAtMs <= Date.now()) {
      this.completed.delete(completed.runnerId);
      return;
    }
    if (!matchesCaller(completed, caller)) return denied();
    return completed;
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
    for (const [runnerId, completed] of this.completed) {
      if (completed.expiresAtMs <= Date.now()) this.completed.delete(runnerId);
    }
    for (const [runId, binding] of this.bindings) {
      if (!binding.proxy && !binding.failedStart && binding.expiresAtMs <= Date.now()) {
        this.bindings.delete(runId);
        continue;
      }
      if (binding.busy) continue;
      if (binding.expiresAtMs > Date.now()) {
        if (binding.failedStart) await this.retryFailedStart(runId);
        continue;
      }
      binding.busy = true;
      try {
        if (binding.proxy) await this.control(binding.bindingId);
      } catch {
        /* The interceptor also enforces the hard expiry. */
      } finally {
        this.bindings.delete(runId);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.readiness.set(0);
    clearInterval(this.cleanup);
    await Promise.allSettled([...this.controls]);
    // Bound shutdown fanout. Failed deletes remain subject to the node's hard expiry.
    const bindings = [...this.bindings.values()].filter((binding) => binding.proxy);
    for (let i = 0; i < bindings.length; i += MAX_IN_FLIGHT) {
      await Promise.allSettled(
        bindings.slice(i, i + MAX_IN_FLIGHT).map((binding) => this.control(binding.bindingId))
      );
    }
    this.bindings.clear();
    this.completed.clear();
  }
}
