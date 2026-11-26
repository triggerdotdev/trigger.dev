import { WORKER_HEADERS } from "@trigger.dev/core/v3/workers";
import { describe, expect, it } from "vitest";
import {
  parseWorkerActionTokenModes,
  type VerifiedWorkerActionToken,
  type WorkerActionTokenConfig,
} from "~/v3/services/worker/workerActionTokenVerifier.server";
import {
  createWorkerActionTokenGate,
  type WorkerActionTokenOutcomeRecord,
  type WorkerActionTokenWorker,
} from "~/v3/services/worker/workerActionTokenGate.server";

const CUTOFF_MS = Date.parse("2026-11-01T00:00:00.000Z");
const RUN = "run_clabcdefghijklmnopqrstuvw";
const TOKEN = "header.payload.signature";

function claims(overrides: Partial<VerifiedWorkerActionToken["claims"]> = {}) {
  return {
    ver: 1 as const,
    deployment: "deployment_abc",
    deployment_version: "20261126.1",
    environment_id: "env_claim",
    environment_type: "PRODUCTION",
    org_id: "org_1",
    project_id: "proj_1",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function setup({
  modes,
  verified,
  createdAt = new Date(CUTOFF_MS + 60_000),
  tokenKind = "child",
  lookupError,
}: {
  modes: string;
  verified?: VerifiedWorkerActionToken;
  createdAt?: Date;
  tokenKind?: WorkerActionTokenWorker["tokenKind"];
  lookupError?: Error;
}) {
  const calls = { verify: 0, reads: 0 };
  const records: WorkerActionTokenOutcomeRecord[] = [];
  const config: WorkerActionTokenConfig = {
    modes: parseWorkerActionTokenModes(modes),
    publicKeys: [],
    cutoffMs: CUTOFF_MS,
  };
  const gate = createWorkerActionTokenGate({
    config,
    verifier: {
      verify(token) {
        calls.verify++;
        return token === TOKEN ? verified : undefined;
      },
    },
    record: (record) => records.push(record),
  });
  const worker: WorkerActionTokenWorker = {
    tokenKind,
    workerGroupId: "group_1",
    name: "instance_1",
    findRunCreatedAt: async () => {
      calls.reads++;
      if (lookupError) throw lookupError;
      return createdAt;
    },
  };
  return { gate, worker, calls, records };
}

function request(token?: string) {
  return new Request("http://localhost/engine", {
    headers: token ? { [WORKER_HEADERS.WORKLOAD_TOKEN]: token } : {},
  });
}

async function thrownResponse(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("expected a thrown Response");
}

describe("worker action token gate", () => {
  it("returns the plain headers and reads no token when off", async () => {
    const { gate, worker, calls, records } = setup({
      modes: "",
      verified: { claims: claims() },
    });
    const result = await gate.apply({
      action: "heartbeat",
      request: request(TOKEN),
      worker,
      runFriendlyId: RUN,
      environmentId: "env_header",
      sandboxRunId: "run_header",
    });
    expect(result).toEqual({ environmentId: "env_header", sandboxRunId: "run_header" });
    expect(calls).toEqual({ verify: 0, reads: 0 });
    expect(records).toHaveLength(0);
  });

  it("replaces the environment with the claim in enforce", async () => {
    const { gate, worker, calls, records } = setup({
      modes: "heartbeat=enforce",
      verified: { claims: claims() },
    });
    const result = await gate.apply({
      action: "heartbeat",
      request: request(TOKEN),
      worker,
      runFriendlyId: RUN,
      environmentId: "env_header",
      sandboxRunId: "run_header",
    });
    expect(result).toEqual({
      environmentId: "env_claim",
      sandboxRunId: undefined,
      tokenEnvironmentId: "env_claim",
    });
    expect(calls.reads).toBe(0);
    expect(records.map((record) => record.outcome)).toEqual(["verified"]);
  });

  it("takes the sandbox run from the claim for a SANDBOX token in enforce", async () => {
    const { gate, worker } = setup({
      modes: "heartbeat=enforce",
      verified: { claims: claims({ execution_mode: "SANDBOX", run: RUN }) },
    });
    const result = await gate.apply({
      action: "heartbeat",
      request: request(TOKEN),
      worker,
      runFriendlyId: RUN,
      environmentId: "env_header",
    });
    expect(result).toMatchObject({ environmentId: "env_claim", sandboxRunId: RUN });
  });

  it("throws a 403 when enforce denies the request", async () => {
    const { gate, worker, calls, records } = setup({
      modes: "heartbeat=enforce",
      verified: { claims: claims() },
    });
    const response = await thrownResponse(
      gate.apply({
        action: "heartbeat",
        request: request(),
        worker,
        runFriendlyId: RUN,
        environmentId: "env_header",
      })
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Run does not belong to this worker" });
    expect(calls.verify).toBe(0);
    expect(records.map((record) => record.outcome)).toEqual(["denied"]);
  });

  it("never throws in log mode and keeps the plain headers", async () => {
    const { gate, worker, calls, records } = setup({
      modes: "default=log",
      verified: { claims: claims() },
    });
    const result = await gate.apply({
      action: "heartbeat",
      request: request(),
      worker,
      runFriendlyId: RUN,
      environmentId: "env_header",
      sandboxRunId: "run_header",
    });
    expect(result).toEqual({ environmentId: "env_header", sandboxRunId: "run_header" });
    expect(calls.verify).toBe(0);
    expect(records.map((record) => record.outcome)).toEqual(["denied"]);
  });

  it("records a lookup error in log mode and keeps the plain headers", async () => {
    const { gate, worker, calls, records } = setup({
      modes: "default=log",
      lookupError: new Error("replica down"),
    });
    const result = await gate.apply({
      action: "heartbeat",
      request: request(),
      worker,
      runFriendlyId: RUN,
      environmentId: "env_header",
      sandboxRunId: "run_header",
    });
    expect(result).toEqual({ environmentId: "env_header", sandboxRunId: "run_header" });
    expect(calls.reads).toBe(1);
    expect(records.map((record) => record.outcome)).toEqual(["lookup_error"]);
  });

  it("fails closed on a lookup error in enforce", async () => {
    const { gate, worker, records } = setup({
      modes: "heartbeat=enforce",
      lookupError: new Error("replica down"),
    });
    await expect(
      gate.apply({
        action: "heartbeat",
        request: request(),
        worker,
        runFriendlyId: RUN,
        environmentId: "env_header",
      })
    ).rejects.toThrow("replica down");
    expect(records.map((record) => record.outcome)).toEqual(["lookup_error"]);
  });

  it.each(["start_version=enforce", "start=log,start_version=enforce"])(
    "drops a previous-key token for a run after its cutoff from the version check (%s)",
    async (modes) => {
      const { gate, worker } = setup({
        modes,
        verified: { claims: claims(), runCutoffMs: CUTOFF_MS },
      });
      const result = await gate.apply({
        action: "start",
        request: request(TOKEN),
        worker,
        runFriendlyId: RUN,
        environmentId: "env_header",
      });
      expect(result).toEqual({ environmentId: "env_header", sandboxRunId: undefined });
    }
  );

  it.each(["start_version=enforce", "start=log,start_version=enforce"])(
    "keeps a previous-key token for a run before its cutoff in the version check (%s)",
    async (modes) => {
      const { gate, worker } = setup({
        modes,
        verified: { claims: claims(), runCutoffMs: CUTOFF_MS + 120_000 },
      });
      const result = await gate.apply({
        action: "start",
        request: request(TOKEN),
        worker,
        runFriendlyId: RUN,
        environmentId: "env_header",
      });
      expect(result).toEqual({
        environmentId: "env_header",
        sandboxRunId: undefined,
        startVersion: { mode: "enforce", deploymentVersion: "20261126.1" },
      });
    }
  );

  it("keeps the plain headers in log mode with a verified token", async () => {
    const { gate, worker, records } = setup({
      modes: "default=log",
      verified: { claims: claims() },
    });
    const result = await gate.apply({
      action: "heartbeat",
      request: request(TOKEN),
      worker,
      runFriendlyId: RUN,
      environmentId: "env_header",
    });
    expect(result).toEqual({ environmentId: "env_header", sandboxRunId: undefined });
    expect(records.map((record) => record.outcome)).toEqual(["env_mismatch"]);
  });

  it("passes the deployment version on start when start_version is on", async () => {
    const { gate, worker } = setup({
      modes: "start_version=enforce",
      verified: { claims: claims() },
    });
    const result = await gate.apply({
      action: "start",
      request: request(TOKEN),
      worker,
      runFriendlyId: RUN,
      environmentId: "env_header",
    });
    expect(result).toEqual({
      environmentId: "env_header",
      sandboxRunId: undefined,
      startVersion: { mode: "enforce", deploymentVersion: "20261126.1" },
    });
  });
});

describe("worker action token start version", () => {
  const startVersion = { mode: "enforce" as const, deploymentVersion: "20261126.1" };

  it("records verified for a matching version", () => {
    const { gate, worker, records } = setup({ modes: "start_version=enforce" });
    gate.assertStartVersion({
      startVersion,
      lockedVersion: "20261126.1",
      worker,
      runFriendlyId: RUN,
    });
    expect(records.map((record) => record.outcome)).toEqual(["verified"]);
  });

  it("throws a 403 for a different version in enforce", async () => {
    const { gate, worker, records } = setup({ modes: "start_version=enforce" });
    let thrown: unknown;
    try {
      gate.assertStartVersion({
        startVersion,
        lockedVersion: "20261125.9",
        worker,
        runFriendlyId: RUN,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
    expect(records.map((record) => record.outcome)).toEqual(["version_mismatch"]);
  });

  it("records a different version without throwing in log mode", () => {
    const { gate, worker, records } = setup({ modes: "start_version=log" });
    gate.assertStartVersion({
      startVersion: { mode: "log", deploymentVersion: "20261126.1" },
      lockedVersion: "20261125.9",
      worker,
      runFriendlyId: RUN,
    });
    expect(records.map((record) => record.outcome)).toEqual(["version_mismatch"]);
  });

  it.each([null, undefined])(
    "allows an unknown locked version (%s) in enforce",
    (lockedVersion) => {
      const { gate, worker, records } = setup({ modes: "start_version=enforce" });
      gate.assertStartVersion({ startVersion, lockedVersion, worker, runFriendlyId: RUN });
      expect(records.map((record) => record.outcome)).toEqual(["version_unknown"]);
    }
  );
});
