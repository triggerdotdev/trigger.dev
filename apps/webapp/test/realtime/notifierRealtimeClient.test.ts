import { CURRENT_API_VERSION } from "~/api/versions";
import {
  NotifierRealtimeClient,
  type RealtimeListEnvironment,
} from "~/services/realtime/notifierRealtimeClient.server";
import { type RealtimeRunRow } from "~/services/realtime/electricStreamProtocol.server";
import { EnvChangeRouter } from "~/services/realtime/envChangeRouter.server";
import { describe, expect, it } from "vitest";

function sampleRow(): RealtimeRunRow {
  return {
    id: "run_1",
    taskIdentifier: "t",
    createdAt: new Date("2026-06-07T10:00:00.000Z"),
    updatedAt: new Date("2026-06-07T10:00:01.000Z"),
    startedAt: null,
    delayUntil: null,
    queuedAt: null,
    expiredAt: null,
    completedAt: null,
    friendlyId: "run_friendly_1",
    number: 1,
    isTest: false,
    status: "EXECUTING",
    usageDurationMs: 0,
    costInCents: 0,
    baseCostInCents: 0,
    ttl: null,
    payload: "{}",
    payloadType: "application/json",
    metadata: null,
    metadataType: "application/json",
    output: null,
    outputType: "application/json",
    runTags: [],
    error: null,
    realtimeStreams: [],
  };
}

// Only the initial-snapshot path is exercised here, which touches the shared
// #buildResponse — enough to lock the response-header contract.
function makeClient(row: RealtimeRunRow | null) {
  return new NotifierRealtimeClient({
    runReader: {
      getRunById: async () => row,
      hydrateByIds: async () => (row ? [row] : []),
    } as any,
    runListResolver: { resolveMatchingRunIds: async () => [] } as any,
    // Snapshot path only; the router (over a no-op source) is never invoked here.
    router: new EnvChangeRouter({
      source: { subscribeToEnv: () => () => {} },
      hydrator: { hydrateByIds: async () => (row ? [row] : []) },
    }),
    limiter: { incrementAndCheck: async () => true, decrement: async () => {} } as any,
    cachedLimitProvider: { getCachedLimit: async () => 100 },
    maximumCreatedAtFilterAgeMs: 24 * 60 * 60 * 1000,
  });
}

const ENV: RealtimeListEnvironment = {
  id: "env_1",
  organizationId: "org_1",
  projectId: "proj_1",
};

describe("NotifierRealtimeClient response headers", () => {
  it("exposes electric headers cross-origin so browser hooks can read them", async () => {
    const client = makeClient(sampleRow());
    const res = await client.streamRun(
      "http://localhost:3030/realtime/v1/runs/run_1?offset=-1",
      ENV,
      "run_1",
      CURRENT_API_VERSION,
      undefined,
      "1.0.0-beta.1" // modern client => lowercase electric-* headers
    );

    // Without these the deployed @electric-sql/client throws MissingHeadersError
    // (it can't read the electric-* headers across origins). This regressed once.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toBe("*");

    // Initial (non-live) snapshot requires offset + handle + schema.
    expect(res.headers.get("electric-offset")).toBeTruthy();
    expect(res.headers.get("electric-handle")).toBeTruthy();
    expect(res.headers.get("electric-schema")).toBeTruthy();
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("renames headers for legacy (0.4.0) clients", async () => {
    const client = makeClient(sampleRow());
    const res = await client.streamRun(
      "http://localhost:3030/realtime/v1/runs/run_1?offset=-1",
      ENV,
      "run_1",
      CURRENT_API_VERSION,
      undefined,
      undefined // no client version => legacy header names
    );

    expect(res.headers.get("electric-chunk-last-offset")).toBeTruthy();
    expect(res.headers.get("electric-shape-id")).toBeTruthy();
    expect(res.headers.get("electric-offset")).toBeNull();
    expect(res.headers.get("electric-handle")).toBeNull();
    expect(res.headers.get("access-control-expose-headers")).toBe("*");
  });
});
