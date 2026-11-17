import type {
  SupervisorHttpClient,
  WorkerApiRunRestoreOutcomeRequestBody,
} from "@trigger.dev/core/v3/workers";
import { chmod } from "node:fs/promises";
import { register } from "../metrics.js";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SecretProxyFixture, deploymentClaims, executionInput } from "./fixtures/secretProxy.js";
import {
  SecretProxyBindings,
  interceptorControl,
  reportSecretProxyRestoreRefusal,
  type SecretProxyCaller,
} from "./secretProxyBindings.js";

type CompletionResponse = Awaited<ReturnType<SupervisorHttpClient["completeRunAttempt"]>>;
const CLEANUP_SWEEP_WAIT_MS = 11_000;

// Authenticated platform metadata and acknowledgements are explicit inputs to this boundary.
// This is not a WorkloadServer, platform, operator, microVM, or relay end-to-end test.
function acknowledged(caller: SecretProxyCaller, snapshotId: string): CompletionResponse {
  return {
    success: true,
    data: {
      result: {
        run: {
          id: caller.runId,
          friendlyId: caller.runId,
          status: "COMPLETED_SUCCESSFULLY",
          attemptNumber: 1,
        },
        snapshot: {
          id: snapshotId,
          friendlyId: snapshotId,
          executionStatus: "FINISHED",
          description: "Completed",
          createdAt: new Date(),
        },
        attemptStatus: "RUN_FINISHED",
      },
    },
  };
}

describe("SecretProxyBindings with real k3s and native interceptor UDS", () => {
  const fixture = new SecretProxyFixture();
  let bindings: SecretProxyBindings;
  let capacityCallers: SecretProxyCaller[];
  let retryCallers: SecretProxyCaller[];

  beforeAll(async () => {
    await fixture.start();
    const callers = await fixture.placements([
      ...Array.from({ length: 129 }, (_, index) => ({ runId: `run_real${index}` })),
      { runId: "run_reattempt", attempt: 1 },
      { runId: "run_reattempt", attempt: 2 },
    ]);
    capacityCallers = callers.slice(0, 129);
    retryCallers = callers.slice(129);
  }, 600_000);

  beforeEach(async () => {
    bindings = new SecretProxyBindings({
      k8s: { core: fixture.core, custom: fixture.custom },
      namespace: fixture.namespace,
      nodeName: fixture.nodeName,
      socketPath: fixture.socketPath,
    });
    await bindings.start();
    await fixture.resetAllocations();
  });
  afterEach(async () => {
    await bindings?.stop();
  });
  afterAll(async () => {
    await fixture.stop();
  }, 60_000);

  async function start(caller: SecretProxyCaller, attempt = 1, allowedHosts?: string[]) {
    await bindings.authorize(caller, true);
    await bindings.exclusive(
      caller.runId,
      async () => {
        bindings.beginStart(caller.runId);
        const input = executionInput(caller, attempt, allowedHosts);
        await bindings.attach(caller.runId, input.proxy, input.runToken);
      },
      caller.runnerId
    );
  }

  async function registrationPresent(caller: SecretProxyCaller, present: boolean, host?: string) {
    expect(await fixture.acceptsTls(caller, host)).toBe(present);
  }

  // Catches: restoring plaintext from a checkpoint taken before enrollment on the proxy lab lane.
  it("reports checkpoint restore failure on the lab lane instead of continuing to restore", async () => {
    const checkpoint = {
      id: "checkpoint_before_enrollment",
      type: "COMPUTE" as const,
      location: "saved",
    };
    const reported: WorkerApiRunRestoreOutcomeRequestBody[] = [];
    let restoreAttempts = 0;
    const refused = await reportSecretProxyRestoreRefusal(
      { interceptorSocket: fixture.socketPath, checkpoint },
      {
        report: async (body) => {
          reported.push(body);
          return { success: true };
        },
        release: async () => {
          throw new Error("An acknowledged refusal must not release the run");
        },
      }
    );
    if (!refused) restoreAttempts++;
    expect(restoreAttempts).toBe(0);
    expect(reported).toEqual([
      {
        outcome: "fail",
        reason: "SecretProxyCheckpointUnsupported",
        message: expect.any(String),
      },
    ]);
    expect(
      await reportSecretProxyRestoreRefusal(
        { checkpoint },
        {
          report: async () => {
            throw new Error("Ordinary restores must not be refused");
          },
          release: async () => {
            throw new Error("Ordinary restores must not be released");
          },
        }
      )
    ).toBe(false);
  });

  // Catches: delayed first PUTs escaping fresh DELETE/reset, or a failed reset enabling new authority.
  it("closes pre-reset contexts including unbound ones and admits only post-reset allocations", async () => {
    const caller = capacityCallers[0]!;
    const oldId = fixture.allocation(caller).metadata.allocationId;
    const input = executionInput(caller);
    await interceptorControl(fixture.socketPath, oldId, {
      ...input.proxy,
      ...fixture.allocation(caller).metadata,
      sourceIp: caller.sourceIp,
      runToken: input.runToken,
    });
    await registrationPresent(caller, true);
    const fresh = capacityCallers[1]!;
    const freshMetadata = fixture.allocation(fresh).metadata;
    const freshInput = executionInput(fresh);
    const latePut = () =>
      interceptorControl(fixture.socketPath, freshMetadata.allocationId, {
        ...freshInput.proxy,
        ...freshMetadata,
        sourceIp: fresh.sourceIp,
        runToken: freshInput.runToken,
      });
    const deleted = capacityCallers[2]!;
    const deletedMetadata = fixture.allocation(deleted).metadata;
    const deletedInput = executionInput(deleted);
    await interceptorControl(fixture.socketPath, deletedMetadata.allocationId);
    await expect(
      interceptorControl(fixture.socketPath, deletedMetadata.allocationId, {
        ...deletedInput.proxy,
        ...deletedMetadata,
        sourceIp: deleted.sourceIp,
        runToken: deletedInput.runToken,
      })
    ).rejects.toThrow();
    expect(await bindings.prepareStart(deleted, false)).toBe(false);
    await chmod(fixture.socketPath, 0o644);
    const restarted = new SecretProxyBindings({
      k8s: { core: fixture.core, custom: fixture.custom },
      namespace: fixture.namespace,
      nodeName: fixture.nodeName,
      socketPath: fixture.socketPath,
    });
    try {
      // Catches: swallowed startup-reset failures reporting proxy readiness or no observable control error.
      const failedResets = async () => {
        const metric = await register
          .getSingleMetric("supervisor_secret_proxy_control_requests_total")!
          .get();
        return metric.values.find(
          (point) => point.labels.operation === "reset" && point.labels.outcome === "error"
        )!.value;
      };
      const before = await failedResets();
      await restarted.start();
      expect(await failedResets()).toBeGreaterThan(before);
      expect(await register.getSingleMetricAsString("supervisor_secret_proxy_ready")).toContain(
        "supervisor_secret_proxy_ready 0"
      );
      expect(await restarted.prepareStart(caller, false)).toBe(false);
      const response = acknowledged(caller, "snap_normal");
      expect(await restarted.complete(caller, "snap_normal", async () => response)).toEqual(
        response
      );
      await chmod(fixture.socketPath, 0o600);
      await restarted.start();
      expect(await register.getSingleMetricAsString("supervisor_secret_proxy_ready")).toContain(
        "supervisor_secret_proxy_ready 1"
      );
      await registrationPresent(caller, false);
      expect(await restarted.prepareStart(caller, false)).toBe(false);
      expect(await restarted.prepareStart(fresh, false)).toBe(false);
      await expect(latePut()).rejects.toThrow();
      await fixture.retireAllocation(fresh);
      await fixture.registerAllocation(fresh);
      expect(await restarted.prepareStart(fresh, false)).toBe(true);
      restarted.beginStart(fresh.runId);
      await restarted.attach(fresh.runId, freshInput.proxy, freshInput.runToken);
      await registrationPresent(fresh, true);
      await fixture.retireAllocation(caller);
      await fixture.registerAllocation(caller);
      expect(await restarted.prepareStart(caller, false)).toBe(true);
      restarted.withoutProxy(caller.runId, caller.runnerId);
    } finally {
      await chmod(fixture.socketPath, 0o600);
      await restarted.stop();
      await interceptorControl(fixture.socketPath, oldId);
    }
  }, 30_000);

  // Catches: ordinary tokenless attempts exhausting proxy capacity, or a reused guest advertising proxy support.
  it("drops ordinary start state and advertises support only for a trusted cold placement", async () => {
    for (const caller of capacityCallers) {
      expect(await bindings.prepareStart(caller, false)).toBe(true);
      await bindings.exclusive(
        caller.runId,
        async () => {
          bindings.beginStart(caller.runId);
          bindings.withoutProxy(caller.runId, caller.runnerId);
        },
        caller.runnerId
      );
      expect(bindings.tracks(caller.runId, caller.runnerId)).toBe(false);
      await bindings.refresh(caller.runId);
    }
    const caller = capacityCallers[0]!;
    expect(await bindings.prepareStart(caller, true)).toBe(false);
    // A reused guest cannot hide its original bootstrap run by omitting the warm flag.
    expect(await bindings.prepareStart({ ...caller, runId: "run_reused" }, false)).toBe(false);
    expect(bindings.tracks(caller.runId)).toBe(false);
    await registrationPresent(caller, false);
    await start(caller);
    await registrationPresent(caller, true);
  }, 60_000);

  // Catches: advertising support without a live cold-execution context, or silently switching allocations after preflight.
  it("declines missing and mismatched contexts before start and pins the discovered allocation", async () => {
    const caller = capacityCallers[0]!;
    await fixture.retireAllocation(caller);
    expect(await bindings.prepareStart(caller, false)).toBe(false);
    expect(bindings.tracks(caller.runId)).toBe(false);
    await fixture.registerAllocation(caller, { runId: "run_other" });
    expect(await bindings.prepareStart(caller, false)).toBe(false);
    await fixture.retireAllocation(caller);
    await fixture.registerAllocation(caller, { attempt: 2 });
    expect(await bindings.prepareStart(caller, false)).toBe(false);
    await fixture.retireAllocation(caller);
    await fixture.registerAllocation(caller);
    expect(await bindings.prepareStart(caller, false)).toBe(true);

    await fixture.retireAllocation(caller);
    await fixture.registerAllocation(caller);
    expect(await bindings.prepareStart(caller, false)).toBe(false);
    bindings.beginStart(caller.runId);
    const input = executionInput(caller);
    await expect(bindings.attach(caller.runId, input.proxy, input.runToken)).rejects.toThrow();
    await registrationPresent(caller, false);
  });

  // Catches: a delayed old-supervisor DELETE revoking a new allocation with reused pod/container identity.
  it("keeps replacement authority live when the old supervisor finishes shutdown", async () => {
    const caller = capacityCallers[0]!;
    await start(caller);
    const previous = bindings;
    try {
      await fixture.retireAllocation(caller);
      bindings = new SecretProxyBindings({
        k8s: { core: fixture.core, custom: fixture.custom },
        namespace: fixture.namespace,
        nodeName: fixture.nodeName,
        socketPath: fixture.socketPath,
      });
      await bindings.start();
      await fixture.registerAllocation(caller);
      await start(caller);
      await previous.stop();
      await registrationPresent(caller, true);
    } finally {
      await previous.stop();
    }
  });

  // Catches: an attach failure stranding an executing attempt, or completion racing uncertain revocation.
  it("retains failed attachment recovery until revocation and platform acknowledgement", async () => {
    const caller = capacityCallers[0]!;
    const snapshotId = "snap_attach_failure";
    expect(await bindings.prepareStart(caller, false)).toBe(true);
    bindings.beginStart(caller.runId);
    const input = executionInput(caller);
    await chmod(fixture.socketPath, 0o644);
    let completionCalls = 0;
    let acknowledge = false;
    const acknowledgement = acknowledged(caller, snapshotId);
    try {
      await expect(bindings.attach(caller.runId, input.proxy, input.runToken)).rejects.toThrow();
      await bindings.failStart(caller, snapshotId, async () => {
        completionCalls++;
        return acknowledge
          ? acknowledgement
          : {
              success: false,
              error: "Platform completion unavailable",
              statusCode: 503,
            };
      });
      await bindings.retryFailedStart(caller.runId);
      expect(completionCalls).toBe(0);
      expect(bindings.tracks(caller.runId)).toBe(true);
    } finally {
      await chmod(fixture.socketPath, 0o600);
    }
    await bindings.retryFailedStart(caller.runId);
    expect(completionCalls).toBe(1);
    expect(bindings.tracks(caller.runId)).toBe(true);
    await expect(bindings.authorize(caller)).rejects.toThrow();
    acknowledge = true;
    await bindings.retryFailedStart(caller.runId);
    expect(completionCalls).toBe(2);
    expect(bindings.tracks(caller.runId)).toBe(false);
    await registrationPresent(caller, false);
    expect(
      await bindings.complete(caller, snapshotId, async () => {
        throw new Error("Acknowledged failure must not complete twice");
      })
    ).toEqual(acknowledgement);
  }, 30_000);

  // Catches: placement identity or token changes reaching the native registry, and shutdown leaving registrations live.
  it("derives placement from real Kubernetes objects and registers, renews, revokes over native UDS", async () => {
    const caller = capacityCallers[0]!;
    await registrationPresent(caller, false);
    await expect(
      bindings.authorize({ ...caller, sourceIp: capacityCallers[1]!.sourceIp }, true)
    ).rejects.toThrow();
    await expect(
      bindings.authorize(
        { ...caller, claims: { ...deploymentClaims, environment_id: "env_other" } },
        true
      )
    ).rejects.toThrow();
    await start(caller, 1, ["api--edge.example.com"]);
    await registrationPresent(caller, true, "api--edge.example.com");

    const changedIdentity = executionInput(caller, 2);
    await expect(bindings.refresh(caller.runId, changedIdentity.runToken)).rejects.toThrow();
    const renewed = executionInput(caller, 1, ["api--edge.example.com"], deploymentClaims.exp + 60);
    await bindings.refresh(caller.runId, renewed.runToken);
    await registrationPresent(caller, true, "api--edge.example.com");
    await bindings.stop();
    await registrationPresent(caller, false);
    // Unknown-generation DELETE is idempotent on the actual Rust control handler.
    await interceptorControl(fixture.socketPath, "already-absent");
  }, 30_000);

  // Catches: token expiry retiring a revoked but unacknowledged completion and losing its runner lock.
  it("keeps completion retry identity past token expiry and cleanup until platform acknowledgement", async () => {
    const caller = capacityCallers[0]!;
    const snapshotId = "snap_expired_completion";
    const expiry = Math.floor(Date.now() / 1000) + 5;
    expect(await bindings.prepareStart(caller, false)).toBe(true);
    bindings.beginStart(caller.runId);
    const input = executionInput(caller, 1, undefined, expiry);
    await bindings.attach(caller.runId, input.proxy, input.runToken);
    const unavailable: CompletionResponse = {
      success: false,
      error: "Unavailable",
      statusCode: 503,
    };
    expect(await bindings.complete(caller, snapshotId, async () => unavailable)).toEqual(
      unavailable
    );
    await sleep(CLEANUP_SWEEP_WAIT_MS);
    expect(bindings.tracks(caller.runId)).toBe(true);
    await bindings.authorize(caller, false, snapshotId);
    await expect(bindings.authorize(caller)).rejects.toThrow();
    await expect(bindings.authorize(caller, false, "snap_other")).rejects.toThrow();
    const response = acknowledged(caller, snapshotId);
    expect(await bindings.complete(caller, snapshotId, async () => response)).toEqual(response);
    expect(bindings.tracks(caller.runId)).toBe(false);
    await registrationPresent(caller, false);
  }, 30_000);

  // Catches: never-acknowledged completions pinning admission indefinitely, or retries renewing their grace.
  it("bounds unacknowledged completion grace and reclaims the slot after the runner disappears", async () => {
    const completionGraceMs = 3_000;
    await bindings.stop();
    bindings = new SecretProxyBindings({
      k8s: { core: fixture.core, custom: fixture.custom },
      namespace: fixture.namespace,
      nodeName: fixture.nodeName,
      socketPath: fixture.socketPath,
      completionGraceMs,
    });
    await bindings.start();
    await fixture.resetAllocations();
    const caller = capacityCallers[0]!;
    const snapshotId = "snap_never_acknowledged";
    const expiry = Math.floor(Date.now() / 1000) + 2;
    expect(await bindings.prepareStart(caller, false)).toBe(true);
    bindings.beginStart(caller.runId);
    const input = executionInput(caller, 1, undefined, expiry);
    await bindings.attach(caller.runId, input.proxy, input.runToken);
    const unavailable: CompletionResponse = {
      success: false,
      error: "Unavailable",
      statusCode: 503,
    };
    await bindings.complete(caller, snapshotId, async () => unavailable);
    await sleep(completionGraceMs / 2);
    await bindings.complete(caller, snapshotId, async () => unavailable);
    await sleep(completionGraceMs / 2 + 100);
    await expect(bindings.authorize(caller, false, snapshotId)).rejects.toThrow();
    await expect(
      bindings.complete(caller, snapshotId, async () => {
        throw new Error("Expired completion must not reach the platform");
      })
    ).rejects.toThrow("Secret proxy execution unavailable");
    await sleep(CLEANUP_SWEEP_WAIT_MS);
    expect(bindings.tracks(caller.runId)).toBe(false);
    expect(await bindings.prepareStart(caller, false)).toBe(false);
    await fixture.retireAllocation(caller);
    await fixture.registerAllocation(caller);
    expect(await bindings.prepareStart(caller, false)).toBe(true);
    bindings.withoutProxy(caller.runId, caller.runnerId);
    await registrationPresent(caller, false);
  }, 30_000);

  // Catches: retirement blocking fresh same-run attempts or old completion retries revoking the new generation.
  it("admits a fresh attempt after acknowledgement and fences stale callers from the new native binding", async () => {
    const previous = retryCallers[0]!;
    const next = retryCallers[1]!;
    const snapshotId = "snap_previous";
    await start(previous);
    const response = acknowledged(previous, snapshotId);
    expect(await bindings.complete(previous, snapshotId, async () => response)).toEqual(response);
    await registrationPresent(previous, false);
    await start(next, 2);
    await registrationPresent(next, true);

    await bindings.authorize(previous, false, snapshotId);
    expect(
      await bindings.complete(previous, snapshotId, async () => {
        throw new Error("An acknowledged completion must not execute again");
      })
    ).toEqual(response);
    await expect(bindings.authorize(previous, true)).rejects.toThrow();
    await expect(bindings.authorize(previous)).rejects.toThrow();
    await expect(bindings.authorize(previous, false, "snap_other")).rejects.toThrow();
    await expect(
      bindings.authorize({ ...previous, sourceIp: next.sourceIp }, false, snapshotId)
    ).rejects.toThrow();
    await expect(
      bindings.exclusive(next.runId, async () => bindings.detach(next.runId), previous.runnerId)
    ).rejects.toThrow();
    await registrationPresent(next, true);

    await bindings.complete(next, "snap_next", async () => acknowledged(next, "snap_next"));
    await registrationPresent(next, false);
  }, 30_000);

  // Catches: oversubscription during concurrent admission, full-capacity reverify failure, premature retirement, and lifetime exhaustion after 128 completions.
  it("bounds live admission, retains unacknowledged completion, and admits the 129th after retirement", async () => {
    const admitted = capacityCallers.slice(0, 127);
    for (const caller of admitted) await start(caller);
    const contenders = capacityCallers.slice(127);
    const admissions = await Promise.allSettled(
      contenders.map((caller) => bindings.authorize(caller, true))
    );
    expect(admissions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = contenders[admissions.findIndex((result) => result.status === "fulfilled")]!;
    const waiting = contenders[admissions.findIndex((result) => result.status === "rejected")]!;
    await start(winner);
    admitted.push(winner);
    await expect(bindings.authorize(admitted[0]!, true)).resolves.toBeUndefined();
    await expect(bindings.authorize(waiting, true)).rejects.toThrow();
    expect(await bindings.prepareStart(waiting, false)).toBe(false);
    // Ordinary requests need no proxy admission even when all native slots are occupied.
    const ordinaryAcknowledgement = acknowledged(waiting, "snap_ordinary");
    expect(
      await bindings.complete(waiting, "snap_ordinary", async () => ordinaryAcknowledgement)
    ).toEqual(ordinaryAcknowledgement);
    await bindings.refresh(waiting.runId);

    const unacknowledged = admitted[0]!;
    const snapshotId = "snap_unacknowledged";
    fixture.pauseInterceptor();
    try {
      await expect(
        bindings.complete(unacknowledged, snapshotId, async () => {
          throw new Error("Completion must not execute without confirmed revocation");
        })
      ).rejects.toThrow("Secret proxy control unavailable");
      await expect(bindings.authorize(waiting, true)).rejects.toThrow();
    } finally {
      fixture.resumeInterceptor();
    }
    const failed: CompletionResponse = {
      success: false,
      error: "Acknowledgement unavailable",
      statusCode: 503,
    };
    expect(await bindings.complete(unacknowledged, snapshotId, async () => failed)).toEqual(failed);
    await registrationPresent(unacknowledged, false);
    await expect(bindings.authorize(waiting, true)).rejects.toThrow();
    await expect(bindings.authorize(unacknowledged)).rejects.toThrow();
    await expect(
      bindings.refresh(unacknowledged.runId, executionInput(unacknowledged).runToken)
    ).rejects.toThrow();
    await bindings.authorize(unacknowledged, false, snapshotId);
    await expect(
      bindings.complete(unacknowledged, snapshotId, async () => {
        throw new Error("Transport failed before acknowledgement");
      })
    ).rejects.toThrow("Transport failed before acknowledgement");
    await expect(bindings.authorize(waiting, true)).rejects.toThrow();

    // Catches: an insecure control socket acknowledging completion or freeing capacity before revocation.
    const permissionFaultCaller = admitted[1]!;
    const permissionFaultSnapshot = "snap_permissions";
    await chmod(fixture.socketPath, 0o644);
    try {
      await expect(
        bindings.complete(permissionFaultCaller, permissionFaultSnapshot, async () => {
          throw new Error("Completion must not execute through an insecure control socket");
        })
      ).rejects.toThrow("Secret proxy execution unavailable");
      await expect(bindings.authorize(waiting, true)).rejects.toThrow();
    } finally {
      await chmod(fixture.socketPath, 0o600);
    }
    await registrationPresent(permissionFaultCaller, true);
    const permissionFaultAck = acknowledged(permissionFaultCaller, permissionFaultSnapshot);
    expect(
      await bindings.complete(
        permissionFaultCaller,
        permissionFaultSnapshot,
        async () => permissionFaultAck
      )
    ).toEqual(permissionFaultAck);
    await registrationPresent(permissionFaultCaller, false);

    for (const caller of admitted.filter((caller) => caller !== permissionFaultCaller)) {
      const completedSnapshot = caller === unacknowledged ? snapshotId : `snap_${caller.runId}`;
      const response = await bindings.complete(caller, completedSnapshot, async () =>
        acknowledged(caller, completedSnapshot)
      );
      expect(response.success).toBe(true);
    }
    await start(waiting);
    await registrationPresent(waiting, true);
  }, 120_000);
});
