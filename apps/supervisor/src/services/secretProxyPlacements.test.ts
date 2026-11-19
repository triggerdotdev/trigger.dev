import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { register } from "../metrics.js";
import { forwardKubernetes } from "./fixtures/forwardKubernetes.js";
import { SecretProxyFixture, deploymentClaims } from "./fixtures/secretProxy.js";
import {
  SecretProxyBindings,
  SecretProxyPlacementPendingError,
  SecretProxyPlacementSaturatedError,
  type SecretProxyCaller,
  type SecretProxyStartResult,
} from "./secretProxyBindings.js";

const LOOKUP_LIMIT = 16;

async function nativeLookups() {
  const metric = await register
    .getSingleMetric("supervisor_secret_proxy_control_requests_total")!
    .get();
  return metric.values
    .filter((value) => value.labels.operation === "lookup")
    .reduce((total, value) => total + value.value, 0);
}

function accepted(caller: SecretProxyCaller): SecretProxyStartResult {
  return {
    execution: {
      run: { id: caller.runId },
      attempt: { number: 1 },
      environment: { id: deploymentClaims.environment_id },
      deployment: { id: deploymentClaims.deployment },
    },
    snapshot: { friendlyId: "snap_start", createdAt: new Date() },
    envVars: {},
  };
}

describe("trusted placement with real k3s and native interceptor", () => {
  const fixture = new SecretProxyFixture();
  let probe: Awaited<ReturnType<typeof forwardKubernetes>>;
  let bindings: SecretProxyBindings;
  let caller: SecretProxyCaller;

  beforeAll(() => fixture.start(), 600_000);
  beforeEach(async () => {
    probe = await forwardKubernetes(fixture.config);
    bindings = new SecretProxyBindings({
      k8s: probe,
      namespace: fixture.namespace,
      nodeName: fixture.nodeName,
      socketPath: fixture.socketPath,
    });
    await bindings.start();
    caller = (await fixture.placements([{ runId: `run_${randomUUID().replaceAll("-", "")}` }]))[0]!;
    await fixture.registerAllocation(caller);
  }, 120_000);
  afterEach(async () => {
    await probe.close();
    await bindings.stop();
  });
  afterAll(() => fixture.stop(), 60_000);

  async function start(input = caller, beforePlatform?: () => Promise<void>) {
    const placement = await bindings.prepareStart(input);
    expect(placement).toBeDefined();
    await bindings.withStart(placement!, async () => {
      await beforePlatform?.();
      await bindings.activateStart(input, placement!, accepted(input));
    });
    return placement!;
  }

  async function deletePod() {
    const pod = await fixture.core.readNamespacedPod({
      name: caller.runnerId!,
      namespace: fixture.namespace,
    });
    await fixture.core.deleteNamespacedPod({
      name: caller.runnerId!,
      namespace: fixture.namespace,
      body: { gracePeriodSeconds: 0, preconditions: { uid: pod.metadata!.uid } },
    });
    await expect
      .poll(
        async () => {
          try {
            await fixture.core.readNamespacedPod({
              name: caller.runnerId!,
              namespace: fixture.namespace,
            });
            return false;
          } catch (error) {
            return (error as { code?: number }).code === 404;
          }
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    return pod;
  }

  it("keeps miss slots through both reads and caller timeout without blocking cached starts", async () => {
    const cold = await start();
    const coldLookups = await nativeLookups();
    const coldRequests = probe.requests.length;
    for (const invalid of [
      { ...caller, sourceIp: "192.0.2.1" },
      { ...caller, claims: { ...deploymentClaims, environment_id: "env_other" } },
      { ...caller, claims: { ...deploymentClaims, deployment: "deployment_other" } },
    ])
      expect(await bindings.prepareStart(invalid)).toBeUndefined();
    expect(probe.requests.length).toBe(coldRequests);
    const invalidLookups = (await nativeLookups()) - coldLookups;
    expect(invalidLookups).toBe(3);

    const release = probe.holdResponses((path) => path.includes("/pods/"));
    const misses = Array.from({ length: LOOKUP_LIMIT }, (_, index) =>
      bindings.prepareStart({ ...caller, runnerId: `runner-missing-${index}` })
    );
    await expect
      .poll(
        () =>
          probe.requests.filter(
            (entry) => entry.path.includes("runner-missing-") && entry.status === 404
          ).length
      )
      .toBe(2 * LOOKUP_LIMIT);
    await Promise.all(misses);
    const beforeWarm = probe.requests.length;
    const warm = await start({ ...caller, runId: "run_warm" }, async () => {
      expect(probe.requests.length).toBe(beforeWarm);
      expect(await nativeLookups()).toBe(coldLookups + invalidLookups + 1);
    });
    expect(warm.allocationId).toBe(cold.allocationId);
    expect(warm.bindingId).not.toBe(cold.bindingId);
    expect(warm.isWarmStart).toBe(true);
    expect(await bindings.prepareStart({ ...caller, runnerId: "runner-over-cap" })).toBeUndefined();
    expect(probe.requests.length).toBe(beforeWarm);
    release();
    await expect
      .poll(async () => {
        const next = await bindings.prepareStart({ ...caller, runnerId: "runner-released" });
        return (
          next === undefined &&
          probe.requests.some((entry) => entry.path.includes("runner-released"))
        );
      })
      .toBe(true);
  }, 20_000);

  it("evicts real deleted generations without evicting their replacement", async () => {
    const old = await start();
    await deletePod();
    await fixture.retireAllocation(caller);
    await fixture.custom.deleteNamespacedCustomObject({
      group: "compute.trigger.dev",
      version: "v1alpha1",
      plural: "runners",
      namespace: fixture.namespace,
      name: caller.runnerId!,
      body: { preconditions: { uid: old.runnerUid } },
    });
    expect(await bindings.prepareStart(caller)).toBeUndefined();
    let forwarded = false;
    await expect(
      bindings.withStart(old, async () => {
        forwarded = true;
      })
    ).rejects.toThrow();
    expect(forwarded).toBe(false);
    caller = (await fixture.placements([{ runId: caller.runId }]))[0]!;
    await fixture.registerAllocation(caller);
    const current = await start();
    expect(current.podUid).not.toBe(old.podUid);
    expect(current.allocationId).not.toBe(old.allocationId);
    const beforeLateDelete = probe.requests.length;
    const beforeLateLookup = await nativeLookups();
    await bindings.revokeRunner(caller.runnerId!, old.runnerUid);
    expect(await bindings.prepareStart(caller)).toMatchObject({ podUid: current.podUid });
    expect(probe.requests.length).toBe(beforeLateDelete);
    expect(await nativeLookups()).toBe(beforeLateLookup + 1);
  }, 60_000);

  it("re-reads Pod identity when the cached allocation was replaced", async () => {
    const old = await start();
    const pod = await deletePod();
    await fixture.retireAllocation(caller);
    await fixture.core.createNamespacedPod({
      namespace: fixture.namespace,
      body: {
        metadata: { name: caller.runnerId, ownerReferences: pod.metadata!.ownerReferences },
        spec: pod.spec,
      },
    });
    await expect
      .poll(
        async () => {
          const current = await fixture.core.readNamespacedPod({
            name: caller.runnerId!,
            namespace: fixture.namespace,
          });
          return current.status?.containerStatuses?.[0]?.state?.running ? current : undefined;
        },
        { timeout: 30_000 }
      )
      .toBeDefined();
    const currentPod = await fixture.core.readNamespacedPod({
      name: caller.runnerId!,
      namespace: fixture.namespace,
    });
    const guestId = currentPod.status!.containerStatuses![0]!.containerID!.replace(
      /^containerd:\/\//,
      ""
    );
    await fixture.registerAllocation(caller, { guestId });
    caller = { ...caller, sourceIp: currentPod.status!.podIP! };
    const current = await start();
    expect(current.podUid).not.toBe(old.podUid);
    expect(current.guestId).toBe(guestId);
  }, 60_000);

  describe("while kubelet has not published the container", () => {
    let pending: SecretProxyCaller;
    beforeEach(async () => {
      pending = await fixture.pendingPlacement(`run_${randomUUID().replaceAll("-", "")}`);
    }, 60_000);
    const reads = (kind: "pods") =>
      probe.requests.filter((entry) => entry.path.includes(`/${kind}/${pending.runnerId}`)).length;

    it("does not make a coalesced caller with other claims wait", async () => {
      const release = probe.holdResponses((path) => path.includes("/pods/"));
      const owner = bindings.prepareStart(pending);
      const other = bindings.prepareStart({
        ...pending,
        claims: { ...deploymentClaims, deployment: "deployment_other" },
      });
      await expect.poll(() => reads("pods")).toBe(1);
      release();
      await expect(owner).rejects.toThrow(SecretProxyPlacementPendingError);
      expect(await other).toBeUndefined();
      expect(reads("pods")).toBe(1);
    }, 20_000);

    it("keeps a retrying caller waiting when lookups are saturated", async () => {
      const release = probe.holdResponses((path) => path.includes("runner-saturating-"));
      const saturating = Array.from({ length: LOOKUP_LIMIT }, (_, index) =>
        bindings.prepareStart({ ...caller, runnerId: `runner-saturating-${index}` })
      );
      await expect
        .poll(() => probe.requests.filter((e) => e.path.includes("runner-saturating-")).length)
        .toBe(2 * LOOKUP_LIMIT);
      expect(await bindings.prepareStart(pending)).toBeUndefined();
      await expect(bindings.prepareStart(pending, { retrying: true })).rejects.toThrow(
        SecretProxyPlacementSaturatedError
      );
      expect(reads("pods")).toBe(0);
      release();
      await Promise.all(saturating);
    }, 20_000);
  });

  it("coalesces concurrent real misses", async () => {
    const release = probe.holdResponses((path) => path.includes("/pods/"));
    const first = bindings.prepareStart(caller);
    const second = bindings.prepareStart(caller);
    await expect.poll(() => probe.requests.filter((entry) => entry.status === 200).length).toBe(2);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a?.podUid).toBeDefined();
    expect(b?.podUid).toBe(a?.podUid);
    expect(probe.requests.length).toBe(2);
  }, 20_000);
});
