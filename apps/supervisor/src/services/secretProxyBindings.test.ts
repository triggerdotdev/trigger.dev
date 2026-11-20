import type { SupervisorHttpClient } from "@trigger.dev/core/v3/workers";
import { chmod } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SecretProxyFixture, deploymentClaims, executionInput } from "./fixtures/secretProxy.js";
import {
  SecretProxyBindings,
  SecretProxyAllocationBusyError,
  interceptorControl,
  type RunExecution,
  type SecretProxyCaller,
  type SecretProxyStartResult,
} from "./secretProxyBindings.js";

type CompletionResponse = Awaited<ReturnType<SupervisorHttpClient["completeRunAttempt"]>>;
const SWEEP_WAIT_MS = 11_000;
const RECOVERY_RETRY_WAIT_MS = 1_100;

function accepted(
  caller: SecretProxyCaller,
  options: {
    attempt?: number;
    snapshotId?: string;
    allowedHosts?: string[];
    expiresAt?: number;
  } = {}
): SecretProxyStartResult {
  const attempt = options.attempt ?? 1;
  const input = executionInput(caller, attempt, options.allowedHosts, options.expiresAt);
  return {
    execution: {
      run: { id: caller.runId },
      attempt: { number: attempt },
      environment: { id: caller.claims!.environment_id },
      deployment: { id: caller.claims!.deployment },
    },
    snapshot: {
      friendlyId: options.snapshotId ?? `snap_${caller.runId}_${attempt}`,
      createdAt: new Date(),
    },
    envVars: { TRIGGER_RUN_TOKEN: input.runToken },
    secretProxy: input.proxy,
  };
}

function execution(
  friendlyId: string,
  executionStatus: string,
  attemptNumber = 1,
  checkpoint?: object
): RunExecution {
  return { run: { attemptNumber }, snapshot: { friendlyId, executionStatus }, checkpoint };
}

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
const unavailable: CompletionResponse = { success: false, error: "Unavailable", statusCode: 503 };

describe("SecretProxyBindings with real k3s and native interceptor UDS", () => {
  const fixture = new SecretProxyFixture();
  let bindings: SecretProxyBindings;
  let callers: SecretProxyCaller[];
  let victim: SecretProxyCaller;
  // The platform's answers for the run's executions since a snapshot, and its latest.
  let executionsSince: RunExecution[] = [];
  let latestExecution: RunExecution | undefined;

  function registrar(completionGraceMs?: number) {
    return new SecretProxyBindings({
      k8s: { core: fixture.core, custom: fixture.custom },
      namespace: fixture.namespace,
      nodeName: fixture.nodeName,
      socketPath: fixture.socketPath,
      completionGraceMs,
      snapshotsSince: async () => executionsSince,
      latestExecution: async () =>
        latestExecution ?? executionsSince[0] ?? execution("snap_unchanged", "EXECUTING"),
    });
  }
  beforeAll(async () => {
    await fixture.start();
    callers = await fixture.placements(
      Array.from({ length: 129 }, (_, index) => ({ runId: `run_real${index}` }))
    );
    [victim] = (await fixture.placements([{ runId: "run_victim" }], {
      ...deploymentClaims,
      environment_id: "env_other",
      deployment: "deployment_other",
    })) as [SecretProxyCaller];
  }, 600_000);
  beforeEach(async () => {
    executionsSince = [];
    latestExecution = undefined;
    bindings = registrar();
    await fixture.resetAllocations();
    await bindings.start();
  });
  afterEach(async () => {
    await bindings.stop();
  });
  afterAll(async () => {
    await fixture.stop();
  }, 60_000);

  async function start(
    caller: SecretProxyCaller,
    options: Parameters<typeof accepted>[1] = {},
    target = bindings
  ) {
    const placement = await target.prepareStart(caller);
    expect(placement).toBeDefined();
    const response = accepted(caller, options);
    await target.withStart(placement!, () => target.activateStart(caller, placement!, response));
    return response;
  }
  async function finish(caller: SecretProxyCaller, snapshotId: string) {
    const response = acknowledged(caller, snapshotId);
    expect(await bindings.complete(caller, async () => response)).toEqual(response);
  }

  it("refuses live and concurrent starts without changing the active binding", async () => {
    const first = callers[0]!;
    const a = await start(first);
    await finish(first, a.snapshot.friendlyId);
    const stalePlacement = await bindings.prepareStart(first);
    const warm = { ...first, runId: "run_warm" };
    const placement = await bindings.prepareStart(warm);
    let forwarded = 0;
    const platform = async () => {
      forwarded++;
    };
    await bindings.withStart(placement!, async () => {
      await expect(bindings.withStart(stalePlacement!, platform)).rejects.toBeInstanceOf(
        SecretProxyAllocationBusyError
      );
      await bindings.activateStart(warm, placement!, accepted(warm));
    });
    await expect(bindings.prepareStart(first)).rejects.toBeInstanceOf(
      SecretProxyAllocationBusyError
    );
    await expect(bindings.withStart(stalePlacement!, platform)).rejects.toBeInstanceOf(
      SecretProxyAllocationBusyError
    );
    expect(forwarded).toBe(0);
    await bindings.authorize(warm);
    await bindings.refresh(warm.runId, executionInput(warm).runToken);
    expect(await fixture.acceptsTls(first)).toBe(true);
    await bindings.complete(first, async () => {
      forwarded++;
      return acknowledged(first, a.snapshot.friendlyId);
    });
    expect(forwarded).toBe(1);
    expect(await fixture.acceptsTls(first)).toBe(true);
  });

  it("does not reserve a victim run during placement checks", async () => {
    const attacker = { ...callers[0]!, runId: victim.runId };
    const placement = await bindings.prepareStart(attacker);
    expect(placement).toBeDefined();
    expect(bindings.tracks(victim.runId)).toBe(false);
    await expect(
      bindings.withStart(placement!, () =>
        bindings.activateStart(attacker, placement!, accepted(victim))
      )
    ).rejects.toThrow();
    expect(bindings.tracks(victim.runId)).toBe(false);
    const response = await start(victim);
    await bindings.authorize(victim);
    await bindings.refresh(victim.runId, executionInput(victim).runToken);
    expect(await fixture.acceptsTls(victim)).toBe(true);
    await finish(victim, response.snapshot.friendlyId);
    expect(await fixture.acceptsTls(victim)).toBe(false);
  });

  it("ignores older attempts but revokes current and legacy completions regardless of snapshot", async () => {
    const caller = callers[0]!;
    const first = await start(caller);
    await finish(caller, first.snapshot.friendlyId);
    const second = await start(caller, { attempt: 2 });
    const rejected: CompletionResponse = {
      success: false,
      error: "Stale snapshot",
      statusCode: 409,
    };
    expect(
      await bindings.complete(
        caller,
        async () => {
          expect(await fixture.acceptsTls(caller)).toBe(true);
          return rejected;
        },
        1
      )
    ).toEqual(rejected);
    await bindings.refresh(caller.runId, executionInput(caller, 2).runToken);
    expect(
      await bindings.complete(
        caller,
        async () => {
          expect(await fixture.acceptsTls(caller)).toBe(false);
          return rejected;
        },
        2
      )
    ).toEqual(rejected);
    await bindings.authorize(caller, true);
    await expect(
      bindings.refresh(caller.runId, executionInput(caller, 2).runToken)
    ).rejects.toThrow();
    await finish(caller, second.snapshot.friendlyId);
    await start(caller, { attempt: 3 });
    await bindings.complete(caller, async () => {
      expect(await fixture.acceptsTls(caller)).toBe(false);
      return acknowledged(caller, "snap_after_continuation");
    });
  });

  it("refuses mismatched callers without forwarding or touching the owner's binding", async () => {
    const caller = callers[0]!;
    await start(caller);
    let forwarded = 0;
    for (const mismatched of [
      { ...callers[1]!, runId: caller.runId },
      { ...caller, sourceIp: callers[1]!.sourceIp },
      { ...caller, claims: { ...deploymentClaims, environment_id: "env_other" } },
      { ...caller, claims: { ...deploymentClaims, deployment: "deployment_other" } },
    ]) {
      await expect(bindings.authorize(mismatched)).rejects.toThrow();
      await expect(bindings.authorize(mismatched, true)).rejects.toThrow();
      await expect(
        bindings.complete(mismatched, async () => {
          forwarded++;
          return acknowledged(caller, "snap_wrong_caller");
        })
      ).rejects.toThrow();
    }
    expect(forwarded).toBe(0);
    expect(await fixture.acceptsTls(caller)).toBe(true);
  });

  it("keeps placement checks read-only and discards accepted ordinary state", async () => {
    for (const caller of callers) {
      const placement = await bindings.prepareStart(caller);
      expect(placement).toBeDefined();
      expect(bindings.tracks(caller.runId)).toBe(false);
      const response = accepted(caller);
      delete response.secretProxy;
      await bindings.withStart(placement!, () =>
        bindings.activateStart(caller, placement!, response)
      );
      expect(bindings.tracks(caller.runId)).toBe(false);
      await bindings.refresh(caller.runId);
    }
  }, 60_000);

  it("lets an ordinary run proceed when its reservation fails and retires the VM next", async () => {
    const caller = callers[0]!;
    const placement = await bindings.prepareStart(caller);
    const response = accepted(caller);
    delete response.secretProxy;
    try {
      await bindings.withStart(placement!, async () => {
        await chmod(fixture.socketPath, 0o644);
        await bindings.activateStart(caller, placement!, response);
      });
    } finally {
      await chmod(fixture.socketPath, 0o600);
    }
    expect(bindings.tracks(caller.runId)).toBe(false);
    await expect(bindings.prepareStart({ ...caller, runId: "run_next" })).rejects.toThrow(
      SecretProxyAllocationBusyError
    );
  });

  it("declines invalid placement and fails closed if the allocation changes after preflight", async () => {
    const caller = callers[0]!;
    for (const invalid of [
      { ...caller, sourceIp: callers[1]!.sourceIp },
      { ...caller, claims: { ...deploymentClaims, environment_id: "env_other" } },
      { ...caller, claims: { ...deploymentClaims, deployment: "deployment_other" } },
    ])
      expect(await bindings.prepareStart(invalid)).toBeUndefined();
    const trusted = await bindings.prepareStart(caller);
    for (const scope of [
      { environment: { id: "env_other" }, deployment: { id: deploymentClaims.deployment } },
      {
        environment: { id: deploymentClaims.environment_id },
        deployment: { id: "deployment_other" },
      },
    ]) {
      const response = accepted(caller);
      response.execution = { ...response.execution, ...scope };
      await expect(
        bindings.withStart(trusted!, () => bindings.activateStart(caller, trusted!, response))
      ).rejects.toThrow();
      expect(bindings.tracks(caller.runId)).toBe(false);
    }
    await fixture.retireAllocation(caller);
    await expect(
      bindings.withStart(trusted!, () => bindings.activateStart(caller, trusted!, accepted(caller)))
    ).rejects.toThrow();
    expect(await bindings.prepareStart(caller)).toBeUndefined();
    await fixture.registerAllocation(caller, { runId: "run_other" });
    expect(await bindings.prepareStart(caller)).toBeUndefined();
    await fixture.retireAllocation(caller);
    await fixture.registerAllocation(caller);
    const placement = await bindings.prepareStart(caller);
    expect(placement).toBeDefined();
    await bindings.withStart(placement!, async () => {
      await fixture.retireAllocation(caller);
      await fixture.registerAllocation(caller);
      await expect(bindings.activateStart(caller, placement!, accepted(caller))).rejects.toThrow();
    });
    expect(await fixture.acceptsTls(caller)).toBe(false);
  });

  it("revokes killed runners only when their trusted UID matches", async () => {
    const caller = callers[0]!;
    const placement = await bindings.prepareStart(caller);
    expect(placement).toBeDefined();
    await start(caller);
    await bindings.revokeRunner(caller.runnerId!, "old-runner-uid");
    expect(await fixture.acceptsTls(caller)).toBe(true);
    await bindings.revokeRunner(caller.runnerId!, placement!.runnerUid);
    expect(await fixture.acceptsTls(caller)).toBe(false);
    expect(bindings.tracks(caller.runId)).toBe(false);
  });

  it("revokes an unknown binding before admitting a start", async () => {
    const caller = callers[0]!;
    const { allocationId, guestId } = fixture.allocation(caller).metadata;
    const input = executionInput(caller);
    await interceptorControl(fixture.socketPath, allocationId, {
      allocationId,
      guestId,
      sourceIp: caller.sourceIp,
      runId: caller.runId,
      attempt: 1,
      runToken: input.runToken,
      expiresAtMs: input.proxy.expiresAtMs,
      allowedHosts: input.proxy.allowedHosts,
    });
    expect(bindings.tracks(caller.runId)).toBe(false);
    expect(await fixture.acceptsTls(caller)).toBe(true);
    const warm = { ...caller, runId: "run_after_lost_state" };
    expect(await bindings.prepareStart(warm)).toBeDefined();
    expect(bindings.tracks(warm.runId)).toBe(false);
    expect(await fixture.acceptsTls(caller)).toBe(false);
    await start(warm);
    expect(await fixture.acceptsTls(caller)).toBe(true);
  });

  it("adopts existing bindings after a restart and completes safely while discovery is unavailable", async () => {
    const warm = { ...callers[0]!, runId: "run_recovered_warm" };
    const warmResponse = await start(warm, { attempt: 2 });
    const completing = callers[1]!;
    const completion = await start(completing);
    await bindings.stop();
    expect(await fixture.acceptsTls(warm)).toBe(true);
    bindings = registrar();
    await chmod(fixture.socketPath, 0o644);
    try {
      await bindings.start();
      expect(await bindings.prepareStart(warm)).toBeUndefined();
      await expect(
        bindings.complete(completing, async () => {
          throw new Error("Unresolved discovery must not acknowledge live authority");
        })
      ).rejects.toThrow("Secret proxy execution unavailable");
      await expect(
        bindings.refresh(warm.runId, warmResponse.envVars.TRIGGER_RUN_TOKEN)
      ).rejects.toThrow();
      expect(await fixture.acceptsTls(completing)).toBe(true);
    } finally {
      await chmod(fixture.socketPath, 0o600);
    }
    await bindings.complete(completing, async () => {
      expect(await fixture.acceptsTls(completing)).toBe(false);
      return acknowledged(completing, completion.snapshot.friendlyId);
    });
    const foreign = { ...callers[2]!, runId: warm.runId };
    await expect(bindings.authorize(foreign)).rejects.toThrow();
    expect(bindings.tracks(warm.runId)).toBe(true);
    await expect(bindings.prepareStart({ ...warm, runId: "run_other" })).rejects.toThrow(
      SecretProxyAllocationBusyError
    );
    await bindings.authorize(warm);
    await bindings.refresh(warm.runId);
    await bindings.refresh(warm.runId, executionInput(warm, 2).runToken);
    expect(await fixture.acceptsTls(warm)).toBe(true);
    await bindings.complete(warm, async () => unavailable, 1);
    expect(await fixture.acceptsTls(warm)).toBe(true);
    await finish(warm, warmResponse.snapshot.friendlyId);
    expect(await fixture.acceptsTls(warm)).toBe(false);
  });

  it("revokes a discovered binding when its Runner is retired before adoption", async () => {
    const caller = { ...callers[0]!, runId: "run_retired_before_adoption" };
    await start(caller);
    await bindings.stop();
    bindings = registrar();
    await bindings.start();
    expect(await fixture.acceptsTls(caller)).toBe(true);
    const busy = await bindings
      .prepareStart({ ...caller, runId: "run_other" })
      .catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(SecretProxyAllocationBusyError);
    const { runner, discovered } = busy as SecretProxyAllocationBusyError;
    expect(discovered?.runId).toBe(caller.runId);
    await bindings.revokeRunner(runner.runnerId, runner.runnerUid, discovered);
    expect(await fixture.acceptsTls(caller)).toBe(false);
    expect(bindings.tracks(caller.runId)).toBe(false);
    await expect(
      bindings.refresh(caller.runId, executionInput(caller).runToken)
    ).resolves.toBeUndefined();
    expect(await fixture.acceptsTls(caller)).toBe(false);
  });

  it("keeps retirement retryable when adoption races it and revokes fail", async () => {
    const caller = { ...callers[0]!, runId: "run_adopted_during_retirement" };
    await start(caller);
    await bindings.stop();
    bindings = registrar();
    await bindings.start();
    const busy = await bindings
      .prepareStart({ ...caller, runId: "run_other" })
      .catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(SecretProxyAllocationBusyError);
    const { runner, discovered } = busy as SecretProxyAllocationBusyError;
    await bindings.authorize(caller);
    await chmod(fixture.socketPath, 0o644);
    try {
      await expect(
        bindings.revokeRunner(runner.runnerId, runner.runnerUid, discovered)
      ).rejects.toThrow();
    } finally {
      await chmod(fixture.socketPath, 0o600);
    }
    expect(await fixture.acceptsTls(caller)).toBe(true);
    await bindings.revokeRunner(runner.runnerId, runner.runnerUid, discovered);
    expect(await fixture.acceptsTls(caller)).toBe(false);
  });

  it("retains post-start attachment failure until revocation and platform acknowledgement", async () => {
    const caller = callers[0]!;
    const placement = await bindings.prepareStart(caller);
    const response = accepted(caller);
    let completed = 0;
    let acknowledge = false;
    try {
      await bindings.withStart(placement!, async () => {
        await chmod(fixture.socketPath, 0o644);
        await expect(bindings.activateStart(caller, placement!, response)).rejects.toThrow();
        await bindings.failStart(caller, placement!.bindingId, async () => {
          completed++;
          return acknowledge ? acknowledged(caller, response.snapshot.friendlyId) : unavailable;
        });
      });
      await bindings.retryFailedStart(placement!.bindingId);
      expect(completed).toBe(0);
    } finally {
      await chmod(fixture.socketPath, 0o600);
    }
    await sleep(RECOVERY_RETRY_WAIT_MS);
    await bindings.retryFailedStart(placement!.bindingId);
    expect(completed).toBe(1);
    expect(bindings.tracks(caller.runId)).toBe(true);
    acknowledge = true;
    await sleep(2 * RECOVERY_RETRY_WAIT_MS);
    await bindings.retryFailedStart(placement!.bindingId);
    expect(completed).toBe(2);
    expect(bindings.tracks(caller.runId)).toBe(false);
  }, 15_000);

  it("drops a permanent completion conflict only after revoking its binding", async () => {
    const caller = callers[0]!;
    const placement = await bindings.prepareStart(caller);
    expect(placement).toBeDefined();
    await bindings.withStart(placement!, () =>
      bindings.activateStart(caller, placement!, accepted(caller))
    );
    expect(await fixture.acceptsTls(caller)).toBe(true);
    let completions = 0;
    await bindings.failStart(caller, placement!.bindingId, async () => {
      completions++;
      expect(await fixture.acceptsTls(caller)).toBe(false);
      return { success: false, error: "Snapshot superseded", statusCode: 400 };
    });
    await bindings.retryFailedStart(placement!.bindingId);
    expect(completions).toBe(1);
    expect(bindings.tracks(caller.runId)).toBe(false);
    await bindings.retryFailedStart(placement!.bindingId);
    expect(completions).toBe(1);
    expect(await bindings.prepareStart(caller)).toBeDefined();
  });

  it("expires a transient failure after revocation without another platform completion", async () => {
    const caller = callers[0]!;
    const placement = await bindings.prepareStart(caller);
    expect(placement).toBeDefined();
    const tokenLifetimeMs = 3_000;
    const response = accepted(caller, {
      expiresAt: Math.floor((Date.now() + tokenLifetimeMs) / 1000),
    });
    await bindings.withStart(placement!, () =>
      bindings.activateStart(caller, placement!, response)
    );
    let completions = 0;
    await bindings.failStart(caller, placement!.bindingId, async () => {
      completions++;
      return unavailable;
    });
    await bindings.retryFailedStart(placement!.bindingId);
    await bindings.retryFailedStart(placement!.bindingId);
    expect(completions).toBe(1);
    await sleep(tokenLifetimeMs + RECOVERY_RETRY_WAIT_MS);
    await bindings.retryFailedStart(placement!.bindingId);
    expect(completions).toBe(1);
    expect(bindings.tracks(caller.runId)).toBe(false);
    expect(await fixture.acceptsTls(caller)).toBe(false);
    expect(await bindings.prepareStart(caller)).toBeDefined();
  }, 15_000);

  it("renews only the current execution token and preserves it on shutdown", async () => {
    const caller = callers[0]!;
    await start(caller, { allowedHosts: ["api--edge.example.com"] });
    expect(await fixture.acceptsTls(caller, "api--edge.example.com")).toBe(true);
    await expect(
      bindings.refresh(caller.runId, executionInput(caller, 2).runToken)
    ).rejects.toThrow();
    const renewed = executionInput(caller, 1, ["api--edge.example.com"], deploymentClaims.exp + 60);
    await bindings.refresh(caller.runId, renewed.runToken);
    expect(await fixture.acceptsTls(caller, "api--edge.example.com")).toBe(true);
    await bindings.stop();
    expect(await fixture.acceptsTls(caller, "api--edge.example.com")).toBe(true);
    await interceptorControl(fixture.socketPath, "absent");
  });

  it("re-reads and revokes expired authority after the control socket recovers", async () => {
    const caller = callers[0]!;
    await start(caller, { expiresAt: Math.floor(Date.now() / 1000) + 5 });
    await chmod(fixture.socketPath, 0o644);
    try {
      await expect
        .poll(() => bindings.tracks(caller.runId), {
          timeout: 2 * SWEEP_WAIT_MS,
          interval: 100,
        })
        .toBe(false);
      await chmod(fixture.socketPath, 0o600);
      const warm = { ...caller, runId: "run_after_expiry_recovery" };
      await start(warm);
      expect(await fixture.acceptsTls(warm)).toBe(true);
    } finally {
      await chmod(fixture.socketPath, 0o600);
    }
  }, 30_000);

  it("lets a pinned VM continue its own attempt after a suspend revocation, and nothing else", async () => {
    const [sandbox] = (await fixture.placements([
      { runId: "run_sandboxsuspend", singleUse: true },
    ])) as [SecretProxyCaller];
    await fixture.registerAllocation(sandbox);
    const first = await start(sandbox);

    await chmod(fixture.socketPath, 0o644);
    await expect(bindings.revokeSuspending(sandbox.runId, "snap_failed")).rejects.toThrow();
    await chmod(fixture.socketPath, 0o600);
    await bindings.authorize(sandbox);
    await bindings.revokeSuspending(sandbox.runId, "snap_revoked");
    expect(await fixture.acceptsTls(sandbox)).toBe(false);

    await expect(bindings.prepareStart(sandbox)).rejects.toBeInstanceOf(
      SecretProxyAllocationBusyError
    );
    const other = { ...sandbox, runId: "run_notthesandbox" };
    expect(await bindings.prepareStart(other, { continuing: true })).toBeUndefined();
    const placement = await bindings.prepareStart(sandbox, { continuing: true });
    expect(placement).toBeDefined();
    const next = accepted(sandbox, { snapshotId: "snap_continued" });
    await bindings.activateContinue(sandbox, placement!, {
      run: { friendlyId: sandbox.runId, attemptNumber: 1 },
      snapshot: next.snapshot,
      runToken: next.envVars.TRIGGER_RUN_TOKEN,
      secretProxy: next.secretProxy,
    });
    expect(await fixture.acceptsTls(sandbox)).toBe(true);
    await finish(sandbox, first.snapshot.friendlyId);
  }, 60_000);

  it("rebinds the source VM on its next heartbeat when the platform discards its suspend", async () => {
    const caller = { ...callers[0]!, runId: "run_discardedsuspend" };
    const response = await start(caller);
    expect(await fixture.acceptsTls(caller)).toBe(true);
    await bindings.revokeSuspending(caller.runId, "snap_discarded");
    expect(await fixture.acceptsTls(caller)).toBe(false);

    // Not rebound before the platform answers that suspend, nor for another VM.
    await bindings.rebindContinued(caller);
    bindings.suspendSettled(caller.runId, "snap_earlier", false);
    await bindings.rebindContinued(caller);
    expect(await fixture.acceptsTls(caller)).toBe(false);
    bindings.suspendSettled(caller.runId, "snap_discarded", false);
    await bindings.rebindContinued({ ...callers[1]!, runId: caller.runId });
    expect(await fixture.acceptsTls(caller)).toBe(false);

    // A stale completion from an earlier attempt leaves it pending.
    await bindings.complete(caller, async () => acknowledged(caller, "snap_old"), 0);
    executionsSince = [execution("snap_waiting", "EXECUTING_WITH_WAITPOINTS")];
    // A history that does not reach the latest snapshot (a lagging replica) is not enough.
    latestExecution = execution("snap_not_replicated", "SUSPENDED", 1, {});
    await bindings.rebindContinued(caller, executionInput(caller).runToken);
    expect(await fixture.acceptsTls(caller)).toBe(false);
    latestExecution = undefined;
    await bindings.rebindContinued(caller, executionInput(caller).runToken);
    expect(await fixture.acceptsTls(caller)).toBe(true);
    await finish(caller, response.snapshot.friendlyId);
    expect(await fixture.acceptsTls(caller)).toBe(false);
  });

  it("does not rebind a source VM once its attempt may run elsewhere", async () => {
    const moved: RunExecution[][] = [
      [execution("snap_checkpointed", "SUSPENDED", 1, {})],
      [execution("snap_pending", "PENDING_EXECUTING")],
      [execution("snap_next_attempt", "EXECUTING", 2)],
    ];
    for (const [index, since] of moved.entries()) {
      const caller = { ...callers[0]!, runId: `run_moved${index}` };
      const response = await start(caller);
      await bindings.revokeSuspending(caller.runId, "snap_lost_ack");
      // A later suspend from the unbound VM must not move the cursor past that history.
      await bindings.revokeSuspending(caller.runId, "snap_later");
      bindings.suspendSettled(caller.runId, "snap_later", false);
      executionsSince = since;
      await bindings.rebindContinued(caller, executionInput(caller).runToken);
      expect(await fixture.acceptsTls(caller)).toBe(false);
      executionsSince = [];
      await bindings.rebindContinued(caller, executionInput(caller).runToken);
      expect(await fixture.acceptsTls(caller)).toBe(false);
      await finish(caller, response.snapshot.friendlyId);
    }
  });

  it("leaves the source VM unbound when the platform accepts its suspend", async () => {
    const caller = { ...callers[0]!, runId: "run_acceptedsuspend" };
    const response = await start(caller);
    await bindings.revokeSuspending(caller.runId, "snap_accepted");
    bindings.suspendSettled(caller.runId, "snap_accepted", true);
    await bindings.rebindContinued(caller, executionInput(caller).runToken);
    expect(await fixture.acceptsTls(caller)).toBe(false);
    await finish(caller, response.snapshot.friendlyId);
  });

  it("lets a restored VM continue after a supervisor restart and a failed suspend, then serve another run", async () => {
    const [restored] = (await fixture.placements([
      { runId: "run_restoredsuspend", checkpoint: "checkpoint_a1b2c3d4" },
    ])) as [SecretProxyCaller];
    await fixture.registerAllocation(restored);
    const placement = await bindings.prepareStart(restored, { continuing: true });
    expect(placement).toBeDefined();
    const first = accepted(restored, { attempt: 2 });
    await bindings.activateContinue(restored, placement!, {
      run: { friendlyId: restored.runId, attemptNumber: 2 },
      snapshot: first.snapshot,
      runToken: first.envVars.TRIGGER_RUN_TOKEN,
      secretProxy: first.secretProxy,
    });
    expect(await fixture.acceptsTls(restored)).toBe(true);

    await bindings.stop();
    bindings = registrar();
    await bindings.start();
    await bindings.authorize(restored);
    await bindings.revokeSuspending(restored.runId, "snap_restored_suspend");
    expect(await fixture.acceptsTls(restored)).toBe(false);

    const retry = await bindings.prepareStart(restored, { continuing: true });
    const next = accepted(restored, { attempt: 2, snapshotId: "snap_restored_continued" });
    await bindings.activateContinue(restored, retry!, {
      run: { friendlyId: restored.runId, attemptNumber: 2 },
      snapshot: next.snapshot,
      runToken: next.envVars.TRIGGER_RUN_TOKEN,
      secretProxy: next.secretProxy,
    });
    expect(await fixture.acceptsTls(restored)).toBe(true);
    await finish(restored, next.snapshot.friendlyId);
    expect(await fixture.acceptsTls(restored)).toBe(false);

    // Its controller keeps polling for warm starts, so it serves the next run like any warm VM.
    const warm = { ...restored, runId: "run_afterrestore" };
    const warmResponse = await start(warm);
    expect(await fixture.acceptsTls(warm)).toBe(true);
    await finish(warm, warmResponse.snapshot.friendlyId);
    expect(await fixture.acceptsTls(warm)).toBe(false);
  }, 60_000);

  it("keeps a revoked completion retryable past token expiry", async () => {
    const caller = callers[0]!;
    const response = await start(caller, { expiresAt: Math.floor(Date.now() / 1000) + 5 });
    expect(await bindings.complete(caller, async () => unavailable)).toEqual(unavailable);
    await sleep(SWEEP_WAIT_MS);
    expect(bindings.tracks(caller.runId)).toBe(true);
    await bindings.authorize(caller, true);
    await expect(bindings.authorize(caller)).rejects.toThrow();
    await finish(caller, response.snapshot.friendlyId);
    expect(await fixture.acceptsTls(caller)).toBe(false);
  }, 30_000);

  it("reclaims expired completion state without extending its grace on retry", async () => {
    await bindings.stop();
    const completionGraceMs = 3_000;
    bindings = registrar(completionGraceMs);
    await bindings.start();
    const caller = callers[0]!;
    await start(caller, { expiresAt: Math.floor(Date.now() / 1000) + 2 });
    await bindings.complete(caller, async () => unavailable);
    await sleep(completionGraceMs / 2);
    await bindings.complete(caller, async () => unavailable);
    await sleep(SWEEP_WAIT_MS);
    expect(bindings.tracks(caller.runId)).toBe(false);
    expect(await bindings.prepareStart(caller)).toBeDefined();
    expect(await fixture.acceptsTls(caller)).toBe(false);
  }, 30_000);

  it("bounds accepted executions and retains capacity until completion is acknowledged", async () => {
    const admitted = callers.slice(0, 128);
    const responses: SecretProxyStartResult[] = [];
    for (const caller of admitted.slice(0, -1)) responses.push(await start(caller));
    const waiting = callers[128]!;
    const placement = await bindings.prepareStart(waiting);
    expect(placement).toBeDefined();
    responses.push(await start(admitted[127]!));
    expect(await bindings.prepareStart(waiting)).toBeDefined();
    await expect(
      bindings.withStart(placement!, () =>
        bindings.activateStart(waiting, placement!, accepted(waiting))
      )
    ).rejects.toThrow();
    expect(bindings.tracks(waiting.runId)).toBe(false);
    let completionCalls = 0;
    let acknowledge = false;
    await bindings.failStart(waiting, placement!.bindingId, async () => {
      completionCalls++;
      return acknowledge ? acknowledged(waiting, "snap_capacity_failure") : unavailable;
    });
    await bindings.retryFailedStart(placement!.bindingId);
    expect(completionCalls).toBe(1);
    expect(await fixture.acceptsTls(admitted[0]!)).toBe(true);
    expect(bindings.tracks(waiting.runId)).toBe(false);
    await expect
      .poll(() => completionCalls, { timeout: 2 * SWEEP_WAIT_MS, interval: 100 })
      .toBeGreaterThan(1);
    acknowledge = true;
    const beforeAcknowledgement = completionCalls;
    await sleep(2 * RECOVERY_RETRY_WAIT_MS);
    await bindings.retryFailedStart(placement!.bindingId);
    expect(completionCalls).toBe(beforeAcknowledgement + 1);
    const acknowledgedCalls = completionCalls;
    await bindings.retryFailedStart(placement!.bindingId);
    expect(completionCalls).toBe(acknowledgedCalls);
    expect(await fixture.acceptsTls(admitted[0]!)).toBe(true);
    const first = admitted[0]!;
    const snapshotId = responses[0]!.snapshot.friendlyId;
    expect(await bindings.complete(first, async () => unavailable)).toEqual(unavailable);
    await expect(
      bindings.withStart(placement!, () =>
        bindings.activateStart(waiting, placement!, accepted(waiting))
      )
    ).rejects.toThrow();
    await finish(first, snapshotId);
    await start(waiting);
    expect(await fixture.acceptsTls(waiting)).toBe(true);
  }, 120_000);
});
