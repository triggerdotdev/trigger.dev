import { setTimeout as sleep } from "node:timers/promises";
import { CURRENT_API_VERSION } from "~/api/versions";
import {
  NotifierRealtimeClient,
  type RealtimeListEnvironment,
} from "~/services/realtime/notifierRealtimeClient.server";
import { type RealtimeRunRow } from "~/services/realtime/electricStreamProtocol.server";
import {
  EnvChangeRouter,
  type EnvChangeSource,
} from "~/services/realtime/envChangeRouter.server";
import { type ChangeRecord } from "~/services/realtime/runChangeNotifier.server";
import { describe, expect, it, vi } from "vitest";

const ENV: RealtimeListEnvironment = { id: "env_1", organizationId: "org_1", projectId: "proj_1" };

// Fixed offset floor: a row's updatedAt above/below it produces a delta / empty diff. The
// createdAt window resolves to this same floor (large maximumCreatedAtFilterAgeMs below).
const FLOOR_MS = Date.UTC(2026, 5, 7, 12, 0, 0);

function row(
  id: string,
  updatedAtMs: number,
  opts: { createdAtMs?: number; tags?: string[] } = {}
): RealtimeRunRow {
  return {
    id,
    runTags: opts.tags ?? ["t"],
    createdAt: new Date(opts.createdAtMs ?? FLOOR_MS + 1_000),
    updatedAt: new Date(updatedAtMs),
  } as unknown as RealtimeRunRow;
}

function rec(runId: string, extra: Partial<ChangeRecord> = {}): ChangeRecord {
  return { v: 1, runId, envId: "env_1", ...extra };
}

/** A controllable EnvChangeSource the test pushes batches into. */
function fakeSource() {
  const listeners = new Map<string, Set<(records: ChangeRecord[]) => void>>();
  const source: EnvChangeSource = {
    subscribeToEnv(envId, onBatch) {
      let set = listeners.get(envId);
      if (!set) {
        set = new Set();
        listeners.set(envId, set);
      }
      set.add(onBatch);
      return () => listeners.get(envId)?.delete(onBatch);
    },
  };
  return {
    source,
    push: (envId: string, records: ChangeRecord[]) => {
      for (const l of listeners.get(envId) ?? []) l(records);
    },
    isSubscribed: (envId: string) => (listeners.get(envId)?.size ?? 0) > 0,
  };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  let rowsToReturn: RealtimeRunRow[] = [];
  const hydrateSpy = vi.fn(async (_env: string, ids: string[]) =>
    rowsToReturn.filter((r) => ids.includes(r.id))
  );
  const resolveSpy = vi.fn(async () => rowsToReturn.map((r) => r.id));
  const src = fakeSource();
  const router = new EnvChangeRouter({ source: src.source, hydrator: { hydrateByIds: hydrateSpy } });

  const client = new NotifierRealtimeClient({
    runReader: { getRunById: async () => null, hydrateByIds: hydrateSpy } as any,
    runListResolver: { resolveMatchingRunIds: resolveSpy } as any,
    router,
    limiter: { incrementAndCheck: async () => true, decrement: async () => {} } as any,
    cachedLimitProvider: { getCachedLimit: async () => 100 },
    // Large so the recovered createdAt floor isn't clamped past FLOOR_MS.
    maximumCreatedAtFilterAgeMs: 100 * 365 * 24 * 60 * 60 * 1000,
    runSetResolveCacheTtlMs: 0,
    livePollTimeoutMs: 10_000,
    ...overrides,
  });

  return { client, src, hydrateSpy, resolveSpy, setRows: (rows: RealtimeRunRow[]) => (rowsToReturn = rows) };
}

function liveRuns(client: NotifierRealtimeClient) {
  return client.streamRuns(
    `http://localhost:3030/realtime/v1/runs?offset=${FLOOR_MS}_1&live=true&handle=runs_${FLOOR_MS}_7`,
    ENV,
    { tags: ["t"] },
    CURRENT_API_VERSION,
    undefined,
    "1.0.0"
  );
}

async function whenWaiting(src: ReturnType<typeof fakeSource>) {
  // Subscribed (feed registered) + a tick so waitForMatch has armed feed.resolve.
  await vi.waitFor(() => expect(src.isSubscribed("env_1")).toBe(true));
  await sleep(15);
}

async function bodyOf(res: Response) {
  return JSON.parse(await res.text()) as Array<{
    headers?: { control?: string; operation?: string };
    value?: unknown;
  }>;
}
const hasRowOp = (body: Awaited<ReturnType<typeof bodyOf>>) =>
  body.some((m) => m?.headers?.operation || (m && typeof m === "object" && "value" in m));
const isUpToDate = (body: Awaited<ReturnType<typeof bodyOf>>) =>
  body.some((m) => m?.headers?.control === "up-to-date");

describe("NotifierRealtimeClient multi-run live path over the router", () => {
  it("a matching change hydrates by id (no ClickHouse) and returns a delta", async () => {
    const { client, src, hydrateSpy, resolveSpy, setRows } = makeClient();
    setRows([row("run_1", FLOOR_MS + 5_000, { tags: ["t"] })]);

    const responsePromise = liveRuns(client);
    await whenWaiting(src);
    src.push("env_1", [rec("run_1", { tags: ["t", "x"] })]);

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(hasRowOp(await bodyOf(res))).toBe(true);
    expect(resolveSpy).not.toHaveBeenCalled(); // ClickHouse skipped
    expect(hydrateSpy).toHaveBeenCalledWith("env_1", ["run_1"], expect.anything());
  });

  it("a change that doesn't match the filter never wakes the feed (no CH, no PG); a later match does", async () => {
    const { client, src, hydrateSpy, resolveSpy, setRows } = makeClient();
    setRows([row("run_1", FLOOR_MS + 5_000, { tags: ["t"] })]);

    const responsePromise = liveRuns(client);
    let settled = false;
    void responsePromise.then(() => (settled = true));
    await whenWaiting(src);

    src.push("env_1", [rec("run_x", { tags: ["other"] })]); // doesn't intersect ["t"]
    await sleep(50);
    expect(settled).toBe(false);
    expect(hydrateSpy).not.toHaveBeenCalled(); // router never routed it
    expect(resolveSpy).not.toHaveBeenCalled();

    src.push("env_1", [rec("run_1", { tags: ["t"] })]);
    const res = await responsePromise;
    expect(settled).toBe(true);
    expect(hasRowOp(await bodyOf(res))).toBe(true);
  });

  it("a matching run created before the window floor is hydrated but dropped (keeps holding)", async () => {
    // Generous backstop so the "still holding" assertion can't race a timeout in slow CI.
    const { client, src, hydrateSpy, resolveSpy, setRows } = makeClient({ livePollTimeoutMs: 1500 });
    setRows([row("run_1", FLOOR_MS + 5_000, { createdAtMs: FLOOR_MS - 10_000, tags: ["t"] })]);

    const responsePromise = liveRuns(client);
    let settled = false;
    void responsePromise.then(() => (settled = true));
    await whenWaiting(src);
    src.push("env_1", [rec("run_1", { tags: ["t"] })]);

    await sleep(40);
    expect(settled).toBe(false); // dropped by the createdAt floor -> held
    expect(hydrateSpy).toHaveBeenCalledWith("env_1", ["run_1"], expect.anything());
    expect(resolveSpy).not.toHaveBeenCalled();

    await responsePromise; // drain via the backstop
  });

  it("the backstop timeout does a full ClickHouse resolve and returns up-to-date", async () => {
    const { client, resolveSpy } = makeClient({ livePollTimeoutMs: 50 });
    const res = await liveRuns(client); // never pushed -> backstop fires
    expect(res.status).toBe(200);
    expect(isUpToDate(await bodyOf(res))).toBe(true);
    expect(resolveSpy).toHaveBeenCalled();
  });

  it("with holdOnEmpty=false, a matched-but-not-advanced change returns up-to-date without ClickHouse", async () => {
    const { client, src, resolveSpy, setRows } = makeClient({ holdOnEmpty: false });
    // Matches the tag and is in-window, but updatedAt is at/below the offset floor -> no delta.
    setRows([row("run_1", FLOOR_MS - 1_000, { tags: ["t"] })]);

    const responsePromise = liveRuns(client);
    await whenWaiting(src);
    src.push("env_1", [rec("run_1", { tags: ["t"] })]);

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(isUpToDate(await bodyOf(res))).toBe(true);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
