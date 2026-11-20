import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import { WORKLOAD_HEADERS } from "@trigger.dev/core/v3/workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretProxyBindings } from "../services/secretProxyBindings.js";
import type { register as metricsRegister } from "../metrics.js";
import type { WorkloadServer } from "./index.js";

const SECRET = "secret-proxy-workload-test-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);
const claims = {
  deployment: "deployment_test",
  deployment_version: "20260710.1",
  environment_id: "env_test",
  environment_type: "PRODUCTION",
  org_id: "org_1",
  project_id: "proj_1",
};
const completion = { ok: true, id: "run_1", outputType: "application/json" };

describe.each([
  { proxy: true, port: 18761 },
  { proxy: false, port: 18762 },
])("workload server with proxy=$proxy", ({ proxy, port }) => {
  const base = `http://127.0.0.1:${port}/api/v1/workload-actions/runs/run_1/snapshots/snapshot_1`;
  const startRunAttempt = vi.fn(async () => ({ success: true as const, data: { envVars: {} } }));
  const continueRunExecution = vi.fn(async () => ({
    success: true as const,
    data: { run: { friendlyId: "run_1" }, snapshot: { friendlyId: "snapshot_2" } },
  }));
  const prepareStart = vi.fn(async (): Promise<unknown> => undefined);
  const completeRunAttempt = vi.fn(async () => ({
    success: true as const,
    data: { result: { attemptStatus: "RUN_FINISHED" } },
  }));
  const originalEnv = { ...process.env };
  let server: WorkloadServer;
  let token: string;
  let pendingPlacement: Error;
  let register: typeof metricsRegister;

  beforeAll(async () => {
    Object.assign(process.env, {
      TRIGGER_API_URL: "http://localhost:3030",
      TRIGGER_WORKER_TOKEN: "test-token",
      MANAGED_WORKER_SECRET: "test-secret",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      WORKLOAD_TOKEN_SECRET: SECRET,
      WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
    });
    vi.resetModules();
    const { WorkloadServer } = await import("./index.js");
    const { SecretProxyPlacementPendingError } = await import("../services/secretProxyBindings.js");
    ({ register } = await import("../metrics.js"));
    pendingPlacement = new SecretProxyPlacementPendingError(() => true);
    token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
    const secretProxy = proxy
      ? ({
          start: async () => {},
          stop: async () => {},
          prepareStart,
          withStart: async (_placement: unknown, operation: () => Promise<unknown>) => operation(),
          activateStart: async () => {},
          tracks: () => false,
          complete: async (_caller: unknown, operation: () => Promise<unknown>) => operation(),
        } as unknown as SecretProxyBindings)
      : undefined;
    server = new WorkloadServer({
      port,
      host: "127.0.0.1",
      workerClient: { startRunAttempt, completeRunAttempt, continueRunExecution } as any,
      secretProxy,
      wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
      wideEventsNoisyRoutes: false,
    });
    await server.start();
  });

  beforeEach(() => {
    startRunAttempt.mockClear();
    completeRunAttempt.mockClear();
    continueRunExecution.mockClear();
    prepareStart.mockReset();
    prepareStart.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await server?.stop();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  function post(path: string, body: unknown) {
    return fetch(`${base}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
      },
      body: JSON.stringify(body),
    });
  }

  it(
    "forwards starts without proxy capability when there is no placement",
    { timeout: 3_000 },
    async () => {
      const res = await post("attempts/start", {});
      expect(res.status).toBe(200);
      // An unready supervisor, saturated lookups or a mismatch never retry.
      if (proxy) expect(prepareStart).toHaveBeenCalledOnce();
      expect(startRunAttempt).toHaveBeenCalledOnce();
      expect((startRunAttempt.mock.calls[0] as unknown[])[2]).toMatchObject({
        supportsSecretProxy: false,
      });
    }
  );

  it.runIf(proxy)(
    "forwards and counts starts when Pod status stays pending",
    { timeout: 10_000 },
    async () => {
      async function unavailableStarts() {
        const metric = register.getSingleMetric(
          "supervisor_secret_proxy_unsupported_starts_total"
        )!;
        const { values } = await metric.get();
        return values.find(({ labels }) => labels.reason === "unavailable")?.value ?? 0;
      }

      const before = await unavailableStarts();
      prepareStart.mockRejectedValue(pendingPlacement);
      const res = await post("attempts/start", {});
      expect(res.status).toBe(200);
      expect(startRunAttempt).toHaveBeenCalledOnce();
      expect((startRunAttempt.mock.calls[0] as unknown[])[2]).toMatchObject({
        supportsSecretProxy: false,
      });
      expect(await unavailableStarts()).toBe(before + 1);
      const wait = register.getSingleMetric("supervisor_secret_proxy_placement_wait_seconds")!;
      expect((await wait.get()).values).toContainEqual(
        expect.objectContaining({
          metricName: "supervisor_secret_proxy_placement_wait_seconds_count",
          labels: { route: "start", outcome: "timeout" },
          value: 1,
        })
      );
    }
  );

  it.runIf(proxy)("waits for a placement before forwarding a start", async () => {
    prepareStart
      .mockRejectedValueOnce(pendingPlacement)
      .mockResolvedValueOnce({ bindingId: "binding_1" });
    const res = await post("attempts/start", {});
    expect(res.status).toBe(200);
    expect(prepareStart.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { continuing: false, retrying: false },
      { continuing: false, retrying: true },
    ]);
    expect(startRunAttempt).toHaveBeenCalledOnce();
    expect((startRunAttempt.mock.calls[0] as unknown[])[2]).toMatchObject({
      supportsSecretProxy: true,
    });
  });

  it.runIf(proxy)("waits for a placement before forwarding a continue", async () => {
    prepareStart
      .mockRejectedValueOnce(pendingPlacement)
      .mockResolvedValueOnce({ bindingId: "binding_1" });
    const res = await fetch(`${base}/continue`, {
      headers: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
      },
    });
    expect(res.status).toBe(200);
    expect(prepareStart).toHaveBeenCalledTimes(2);
    expect((continueRunExecution.mock.calls[0] as unknown[])[4]).toMatchObject({
      supportsSecretProxy: true,
    });
  });

  it(`${proxy ? "forwards" : "strips"} the completion attempt number`, async () => {
    const res = await post("attempts/complete", { completion, attemptNumber: 1 });
    expect(res.status).toBe(200);
    const body = (completeRunAttempt.mock.calls[0] as unknown[])[2];
    if (proxy) expect(body).toMatchObject({ attemptNumber: 1 });
    else expect(body).not.toHaveProperty("attemptNumber");
  });
});
