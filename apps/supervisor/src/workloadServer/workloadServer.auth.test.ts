import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { WORKLOAD_HEADERS } from "@trigger.dev/core/v3/workers";
import { io } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Set enforce mode + secret before env.ts parses (vi.mock is hoisted above imports, so the secret
// must be a literal here). SECRET below mirrors it for use in the test body.
vi.mock("std-env", () => ({
  env: {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    WORKLOAD_TOKEN_SECRET: "integration-test-secret",
    WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
    WORKLOAD_TOKEN_SECRET_PREVIOUS: "previous-test-secret",
    WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z",
    WORKLOAD_TOKEN_PREVIOUS_CUTOFF_MODE: "enforce",
  },
}));

const SECRET = "integration-test-secret";
const PREVIOUS_SECRET = "previous-test-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);
const BEFORE_CUTOFF_MS = Date.UTC(2026, 0, 1);
const AFTER_CUTOFF_MS = Date.UTC(2026, 9, 1);

const { WorkloadServer } = await import("./index.js");
const { register } = await import("../metrics.js");

function runIdCreatedAt(ms: number) {
  const now = vi.spyOn(Date, "now").mockReturnValue(ms);
  try {
    return `run_${generateRunOpsId("us-east-1")}`;
  } finally {
    now.mockRestore();
  }
}

async function metricValue(name: string, labels: Record<string, string>) {
  const metric = await register.getSingleMetric(name)?.get();
  const match = metric?.values.find((v) =>
    Object.entries(labels).every(([k, value]) => v.labels[k] === value)
  );
  return match?.value ?? 0;
}

const PORT = 18732;
const BASE = `http://127.0.0.1:${PORT}`;

function claims(environmentId = "env_test_123") {
  return {
    deployment: "deployment_test",
    deployment_version: "20260710.1",
    environment_id: environmentId,
    environment_type: "PRODUCTION",
    org_id: "org_1",
    project_id: "proj_1",
  };
}

// Records the args each relay method is called with so we can assert the forwarded claim.
const calls: { getSnapshotsSince: any[][] } = { getSnapshotsSince: [] };

const workerClient = {
  getSnapshotsSince: vi.fn(async (...args: any[]) => {
    calls.getSnapshotsSince.push(args);
    return { success: true as const, data: { snapshots: [] } };
  }),
} as any;

let server: InstanceType<typeof WorkloadServer>;

beforeAll(async () => {
  server = new WorkloadServer({
    port: PORT,
    workerClient,
    wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
    wideEventsNoisyRoutes: false,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

function snapshotsSince(deploymentIdHeader?: string, runId = "run_1") {
  const headers: Record<string, string> = {
    [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
  };
  if (deploymentIdHeader !== undefined) {
    headers[WORKLOAD_HEADERS.DEPLOYMENT_ID] = deploymentIdHeader;
  }
  return fetch(`${BASE}/api/v1/workload-actions/runs/${runId}/snapshots/since/snap_1`, {
    headers,
  });
}

describe("WorkloadServer auth (enforce mode)", () => {
  it("allows a valid token and forwards the verified environment_id", async () => {
    const token = await mintWorkloadDeploymentToken(claims("env_forwarded_42"), SECRET, EXP);
    const res = await snapshotsSince(token);

    expect(res.status).toBe(200);
    const lastCall = calls.getSnapshotsSince.at(-1)!;
    // getSnapshotsSince(runId, snapshotId, runnerId, environmentId)
    expect(lastCall[3]).toBe("env_forwarded_42");
  });

  it("rejects a token signed with the wrong secret (401) and does not relay", async () => {
    const before = calls.getSnapshotsSince.length;
    const badToken = await mintWorkloadDeploymentToken(claims(), "wrong-secret", EXP);
    const res = await snapshotsSince(badToken);

    expect(res.status).toBe(401);
    expect(calls.getSnapshotsSince.length).toBe(before);
  });

  it("allows a legacy bare friendlyId and forwards no environment_id", async () => {
    const res = await snapshotsSince("deployment_legacy_bare");

    expect(res.status).toBe(200);
    expect(calls.getSnapshotsSince.at(-1)![3]).toBeUndefined();
  });

  it("allows an absent token and forwards no environment_id", async () => {
    const res = await snapshotsSince(undefined);

    expect(res.status).toBe(200);
    expect(calls.getSnapshotsSince.at(-1)![3]).toBeUndefined();
  });
});

describe("WorkloadServer auth with a previous key (enforce cutoff)", () => {
  it("accepts a previous-key token for a legacy run id and forwards its environment_id", async () => {
    const token = await mintWorkloadDeploymentToken(
      claims("env_prev_legacy"),
      PREVIOUS_SECRET,
      EXP
    );
    const res = await snapshotsSince(token, "run_cm1legacy0000000000000");

    expect(res.status).toBe(200);
    expect(calls.getSnapshotsSince.at(-1)![3]).toBe("env_prev_legacy");
  });

  it("accepts a previous-key token for a run created before the cutoff", async () => {
    const token = await mintWorkloadDeploymentToken(
      claims("env_prev_before"),
      PREVIOUS_SECRET,
      EXP
    );
    const res = await snapshotsSince(token, runIdCreatedAt(BEFORE_CUTOFF_MS));

    expect(res.status).toBe(200);
    expect(calls.getSnapshotsSince.at(-1)![3]).toBe("env_prev_before");
  });

  it("rejects a previous-key token for a run created after the cutoff (401) and does not relay", async () => {
    const before = calls.getSnapshotsSince.length;
    const failsBefore = await metricValue("workload_token_previous_cutoff_total", {
      result: "fail",
      mode: "enforce",
    });
    const token = await mintWorkloadDeploymentToken(claims(), PREVIOUS_SECRET, EXP);
    const res = await snapshotsSince(token, runIdCreatedAt(AFTER_CUTOFF_MS));

    expect(res.status).toBe(401);
    expect(calls.getSnapshotsSince.length).toBe(before);
    expect(
      await metricValue("workload_token_previous_cutoff_total", { result: "fail", mode: "enforce" })
    ).toBe(failsBefore + 1);
  });

  it("never applies the cutoff to a current-key token", async () => {
    const checksBefore =
      (await metricValue("workload_token_previous_cutoff_total", { result: "pass" })) +
      (await metricValue("workload_token_previous_cutoff_total", { result: "fail" }));
    const token = await mintWorkloadDeploymentToken(claims("env_current_after"), SECRET, EXP);
    const res = await snapshotsSince(token, runIdCreatedAt(AFTER_CUTOFF_MS));

    expect(res.status).toBe(200);
    expect(calls.getSnapshotsSince.at(-1)![3]).toBe("env_current_after");
    const checksAfter =
      (await metricValue("workload_token_previous_cutoff_total", { result: "pass" })) +
      (await metricValue("workload_token_previous_cutoff_total", { result: "fail" }));
    expect(checksAfter).toBe(checksBefore);
  });

  it("records the key on the verify counter", async () => {
    const before = await metricValue("workload_auth_verify_total", {
      outcome: "jwt_valid",
      transport: "http",
      key: "previous",
    });
    const token = await mintWorkloadDeploymentToken(claims(), PREVIOUS_SECRET, EXP);
    await snapshotsSince(token);

    expect(
      await metricValue("workload_auth_verify_total", {
        outcome: "jwt_valid",
        transport: "http",
        key: "previous",
      })
    ).toBe(before + 1);
  });

  it("accepts a previous-key token on the WS handshake", async () => {
    const token = await mintWorkloadDeploymentToken(claims(), PREVIOUS_SECRET, EXP);
    const client = io(`http://127.0.0.1:${PORT}/workload`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_ws",
      },
    });

    try {
      const connected = await new Promise<boolean>((resolve) => {
        client.once("connect", () => resolve(true));
        client.once("disconnect", () => resolve(false));
        client.once("connect_error", () => resolve(false));
      });
      expect(connected).toBe(true);
      expect(
        await metricValue("workload_auth_verify_total", {
          outcome: "jwt_valid",
          transport: "ws",
          key: "previous",
        })
      ).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  it("ignores run:start and run:stop from a previous-key socket for a post-cutoff run", async () => {
    const token = await mintWorkloadDeploymentToken(claims(), PREVIOUS_SECRET, EXP);
    const client = io(`http://127.0.0.1:${PORT}/workload`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_ws_bind",
      },
    });
    const connected: string[] = [];
    const disconnected: string[] = [];
    const onConnected = ({ run }: { run: { friendlyId: string } }) =>
      connected.push(run.friendlyId);
    const onDisconnected = ({ run }: { run: { friendlyId: string } }) =>
      disconnected.push(run.friendlyId);
    server.on("runConnected", onConnected);
    server.on("runDisconnected", onDisconnected);

    try {
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      const afterRun = runIdCreatedAt(AFTER_CUTOFF_MS);
      const beforeRun = runIdCreatedAt(BEFORE_CUTOFF_MS);
      const message = (friendlyId: string) => ({
        version: "1" as const,
        run: { friendlyId },
        snapshot: { friendlyId: "snap_1" },
      });

      const beforeBound = new Promise<void>((resolve) =>
        server.once("runConnected", () => resolve())
      );
      client.emit("run:start", message(afterRun));
      client.emit("run:start", message(beforeRun));
      await beforeBound;

      const beforeUnbound = new Promise<void>((resolve) =>
        server.once("runDisconnected", () => resolve())
      );
      client.emit("run:stop", message(afterRun));
      client.emit("run:stop", message(beforeRun));
      await beforeUnbound;

      expect(connected).toEqual([beforeRun]);
      expect(disconnected).toEqual([beforeRun]);
    } finally {
      server.off("runConnected", onConnected);
      server.off("runDisconnected", onDisconnected);
      client.close();
    }
  });

  it.each([
    ["previous", PREVIOUS_SECRET],
    ["current", SECRET],
  ])(
    "logs and ignores malformed run:start and run:stop from a %s-key socket",
    async (keyName, secret) => {
      const token = await mintWorkloadDeploymentToken(claims(), secret, EXP);
      const client = io(`http://127.0.0.1:${PORT}/workload`, {
        transports: ["websocket"],
        reconnection: false,
        extraHeaders: {
          [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
          [WORKLOAD_HEADERS.RUNNER_ID]: `runner_malformed_${keyName}`,
        },
      });
      const events: string[] = [];
      const onConnected = ({ run }: { run: { friendlyId: string } }) =>
        events.push(`connected:${run.friendlyId}`);
      const onDisconnected = ({ run }: { run: { friendlyId: string } }) =>
        events.push(`disconnected:${run.friendlyId}`);
      server.on("runConnected", onConnected);
      server.on("runDisconnected", onDisconnected);
      const errors = vi.spyOn(console, "error");

      try {
        await new Promise<void>((resolve) => client.once("connect", () => resolve()));
        const malformed: unknown[] = [
          { version: "1", snapshot: { friendlyId: "snap_1" } },
          { version: "1", run: { friendlyId: 123 }, snapshot: { friendlyId: "snap_1" } },
        ];
        const emitRaw = client.emit.bind(client) as (event: string, payload: unknown) => void;
        for (const payload of malformed) {
          emitRaw("run:start", payload);
          emitRaw("run:stop", payload);
        }

        const validRun = runIdCreatedAt(BEFORE_CUTOFF_MS);
        const bound = new Promise<void>((resolve) => server.once("runConnected", () => resolve()));
        client.emit("run:start", {
          version: "1",
          run: { friendlyId: validRun },
          snapshot: { friendlyId: "snap_1" },
        });
        await bound;

        expect(events).toEqual([`connected:${validRun}`]);
        expect(client.connected).toBe(true);
        const logged = errors.mock.calls.map((args) => args.join(" ")).join("\n");
        expect(logged.match(/run:start error/g)).toHaveLength(2);
        expect(logged.match(/run:stop error/g)).toHaveLength(2);

        const unbound = new Promise<void>((resolve) =>
          server.once("runDisconnected", () => resolve())
        );
        client.close();
        await unbound;
      } finally {
        errors.mockRestore();
        server.off("runConnected", onConnected);
        server.off("runDisconnected", onDisconnected);
        client.close();
      }
    }
  );
});
