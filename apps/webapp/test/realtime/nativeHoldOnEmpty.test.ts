import { setTimeout as sleep } from "node:timers/promises";
import { CURRENT_API_VERSION } from "~/api/versions";
import {
  NativeRealtimeClient,
  type RealtimeListEnvironment,
} from "~/services/realtime/nativeRealtimeClient.server";
import { type RealtimeRunRow } from "~/services/realtime/electricStreamProtocol.server";
import { EnvChangeRouter, type EnvChangeSource } from "~/services/realtime/envChangeRouter.server";
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
  const router = new EnvChangeRouter({
    source: src.source,
    hydrator: { hydrateByIds: hydrateSpy },
    replayWindowMs: 0,
    unsubscribeLingerMs: 0,
    ...((overrides.routerOptions as Record<string, unknown>) ?? {}),
  });
  delete overrides.routerOptions;

  const client = new NativeRealtimeClient({
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

  return {
    client,
    src,
    hydrateSpy,
    resolveSpy,
    setRows: (rows: RealtimeRunRow[]) => (rowsToReturn = rows),
  };
}

function liveRuns(client: NativeRealtimeClient) {
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

describe("NativeRealtimeClient multi-run live path over the router", () => {
  it("a matching change hydrates by id (no ClickHouse) and returns a delta", async () => {
    const emits: Array<[string, number, number]> = [];
    const { client, src, hydrateSpy, resolveSpy, setRows } = makeClient({
      onEmit: (path: string, lagMs: number, rows: number) => emits.push([path, lagMs, rows]),
    });
    setRows([row("run_1", FLOOR_MS + 5_000, { tags: ["t"] })]);

    const responsePromise = liveRuns(client);
    await whenWaiting(src);
    src.push("env_1", [rec("run_1", { tags: ["t", "x"] })]);

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(hasRowOp(await bodyOf(res))).toBe(true);
    expect(resolveSpy).not.toHaveBeenCalled(); // ClickHouse skipped
    expect(hydrateSpy).toHaveBeenCalledWith("env_1", ["run_1"], expect.anything());
    expect(emits).toHaveLength(1);
    expect(emits[0][0]).toBe("fast-hydrate");
    expect(emits[0][2]).toBe(1); // one delta row
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
    const { client, src, hydrateSpy, resolveSpy, setRows } = makeClient({
      livePollTimeoutMs: 1500,
    });
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
    const backstopResults: string[] = [];
    const { client, resolveSpy } = makeClient({
      livePollTimeoutMs: 50,
      onBackstopResult: (r: string) => backstopResults.push(r),
    });
    const res = await liveRuns(client); // never pushed -> backstop fires
    expect(res.status).toBe(200);
    expect(isUpToDate(await bodyOf(res))).toBe(true);
    expect(resolveSpy).toHaveBeenCalled();
    expect(backstopResults).toEqual(["empty"]);
  });

  it("a cold env registration resolves immediately instead of holding blind", async () => {
    // Fresh env subscription (gapCovered=false): a change in the inter-poll gap may have
    // been missed, so the live poll probes once. The row advanced past the offset floor.
    const { client, resolveSpy, setRows } = makeClient({
      routerOptions: { replayWindowMs: 2_000 },
    });
    setRows([row("run_1", FLOOR_MS + 5_000, { tags: ["t"] })]);

    const res = await liveRuns(client); // no push needed — the cold probe finds the delta
    expect(res.status).toBe(200);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(hasRowOp(await bodyOf(res))).toBe(true);
  });

  it("a cold probe with nothing missed keeps holding", async () => {
    const { client, src, resolveSpy, setRows } = makeClient({
      routerOptions: { replayWindowMs: 2_000 },
      livePollTimeoutMs: 1_500,
    });
    setRows([row("run_1", FLOOR_MS - 1_000, { tags: ["t"] })]); // at/below the offset floor

    const responsePromise = liveRuns(client);
    let settled = false;
    void responsePromise.then(() => (settled = true));
    await whenWaiting(src);
    await sleep(50);
    expect(settled).toBe(false); // probed, found nothing missed, held
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    await responsePromise; // drain via the backstop
  });

  it("a single-run poll holds on a replayed already-seen record instead of busy re-polling", async () => {
    const { client, src, setRows } = makeClient({
      routerOptions: { replayWindowMs: 2_000 },
      livePollTimeoutMs: 300,
    });
    setRows([row("run_1", FLOOR_MS + 1_000)]);
    const url = `http://localhost:3030/realtime/v1/runs/run_1?offset=${FLOOR_MS + 1_000}_1&handle=run-run_1&live=true`;

    // First poll subscribes the env, then drains via its backstop.
    const first = await client.streamRun(
      url,
      ENV,
      "run_1",
      CURRENT_API_VERSION,
      undefined,
      "1.0.0"
    );
    expect(first.status).toBe(200);

    // The record lands between polls; the lingering env subscription buffers it.
    src.push("env_1", [rec("run_1")]);

    // The next poll replays it, but the row hasn't advanced past the client's offset:
    // the poll must HOLD (the old behavior returned up-to-date instantly = a busy loop).
    let settled = false;
    const second = client.streamRun(url, ENV, "run_1", CURRENT_API_VERSION, undefined, "1.0.0");
    void second.then(() => (settled = true));
    await sleep(120);
    expect(settled).toBe(false);
    expect((await second).status).toBe(200); // drains via the backstop
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
