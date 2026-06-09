import { CURRENT_API_VERSION } from "~/api/versions";
import {
  NotifierRealtimeClient,
  type RealtimeListEnvironment,
} from "~/services/realtime/notifierRealtimeClient.server";
import { type RealtimeRunRow } from "~/services/realtime/electricStreamProtocol.server";
import { describe, expect, it, vi } from "vitest";

const ENV: RealtimeListEnvironment = { id: "env_1", organizationId: "org_1", projectId: "proj_1" };

// Fixed offset floor so a row's updatedAt being above/below it deterministically
// produces a delta / empty diff.
const FLOOR_MS = Date.UTC(2026, 5, 7, 12, 0, 0);

function row(id: string, updatedAtMs: number): RealtimeRunRow {
  return {
    id,
    createdAt: new Date("2026-06-07T09:00:00.000Z"),
    updatedAt: new Date(updatedAtMs),
  } as unknown as RealtimeRunRow;
}

/** A notifier whose env wakes are driven manually via wake(). Each live-poll loop
 * iteration subscribes once (one-shot), so wake() releases exactly one iteration. */
function controllableNotifier() {
  const pending: Array<() => void> = [];
  return {
    subscribeToRunChanges: () => ({ changed: new Promise<void>(() => {}), unsubscribe() {} }),
    subscribeToEnvChanges: () => {
      let resolve!: () => void;
      const changed = new Promise<void>((r) => {
        resolve = r;
      });
      pending.push(resolve);
      return { changed, unsubscribe() {} };
    },
    wake() {
      pending.shift()?.();
    },
    pending() {
      return pending.length;
    },
  };
}

function makeClient(notifier: unknown, overrides: Record<string, unknown> = {}) {
  let rowsToReturn: RealtimeRunRow[] = [];
  const hydrateSpy = vi.fn(async () => rowsToReturn);

  const client = new NotifierRealtimeClient({
    runReader: { getRunById: async () => null, hydrateByIds: hydrateSpy } as any,
    runListResolver: { resolveMatchingRunIds: async () => ["run_1"] } as any,
    notifier: notifier as any,
    limiter: { incrementAndCheck: async () => true, decrement: async () => {} } as any,
    cachedLimitProvider: { getCachedLimit: async () => 100 },
    maximumCreatedAtFilterAgeMs: 24 * 60 * 60 * 1000,
    // Disable the resolve cache so each held iteration re-hydrates the latest rows.
    runSetResolveCacheTtlMs: 0,
    livePollTimeoutMs: 10_000,
    ...overrides,
  });

  return { client, hydrateSpy, setRows: (rows: RealtimeRunRow[]) => (rowsToReturn = rows) };
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

async function bodyOf(res: Response) {
  return JSON.parse(await res.text()) as Array<{ headers?: { control?: string; operation?: string }; value?: unknown }>;
}
const hasRowOp = (body: Awaited<ReturnType<typeof bodyOf>>) =>
  body.some((m) => m?.headers?.operation || (m && typeof m === "object" && "value" in m));
const isUpToDate = (body: Awaited<ReturnType<typeof bodyOf>>) =>
  body.some((m) => m?.headers?.control === "up-to-date");

describe("NotifierRealtimeClient lever A (hold-on-empty)", () => {
  it("holds the long-poll on an empty diff and only responds when a real delta arrives", async () => {
    const notifier = controllableNotifier();
    const { client, hydrateSpy, setRows } = makeClient(notifier);
    setRows([row("run_1", FLOOR_MS - 1_000)]); // older than the floor -> empty diff

    const responsePromise = liveRuns(client);
    let settled = false;
    void responsePromise.then(() => (settled = true));

    // Feed subscribed and is waiting.
    await vi.waitFor(() => expect(notifier.pending()).toBe(1));

    // An irrelevant change wakes the env channel, but this feed's diff is empty.
    notifier.wake();
    // It must re-subscribe and keep holding (no response yet), having refetched once.
    await vi.waitFor(() => expect(notifier.pending()).toBe(1));
    expect(settled).toBe(false);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);

    // A relevant change: a row advances past the floor.
    setRows([row("run_1", FLOOR_MS + 5_000)]);
    notifier.wake();

    const res = await responsePromise;
    expect(settled).toBe(true);
    expect(res.status).toBe(200);
    expect(hasRowOp(await bodyOf(res))).toBe(true);
  });

  it("returns up-to-date once the backstop elapses with no relevant change", async () => {
    const notifier = controllableNotifier();
    const { client } = makeClient(notifier, { livePollTimeoutMs: 50 });
    // No rows ever match; never wake -> the backstop fires and we return up-to-date.
    const res = await liveRuns(client);
    expect(res.status).toBe(200);
    expect(isUpToDate(await bodyOf(res))).toBe(true);
  });

  it("with holdOnEmpty=false, returns up-to-date on the first empty wake (legacy behavior)", async () => {
    const notifier = controllableNotifier();
    const { client } = makeClient(notifier, { holdOnEmpty: false });

    const responsePromise = liveRuns(client);
    await vi.waitFor(() => expect(notifier.pending()).toBe(1));
    notifier.wake(); // empty diff -> legacy path returns immediately

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(isUpToDate(await bodyOf(res))).toBe(true);
  });
});
