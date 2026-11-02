import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import componentSchema from "../node_modules/@trigger.dev/convex/dist/component/schema.js";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { jobWorkerToken } from "../shared/workerAuth";
import { COOLDOWN_MS, MAX_JOBS, DAILY_JOB_LIMIT, RESULT_TTL_MS, VARIANTS } from "../shared/catalog";
import type { Id } from "./_generated/dataModel";

const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);
const DAY_MS = 24 * 60 * 60_000;
const args = {
  sessionToken: OWNER,
  sample: "forest" as const,
  preset: "balanced" as const,
  prompt: "Make it winter",
  requestId: "request-first",
};
const modules = import.meta.glob("./**/*.ts");
const componentModules = {
  "./_generated/component.js": () =>
    import("../node_modules/@trigger.dev/convex/dist/component/_generated/component.js"),
  "./runs.js": () => import("../node_modules/@trigger.dev/convex/dist/component/runs.js"),
  "./worker.js": () => import("../node_modules/@trigger.dev/convex/dist/component/worker.js"),
};
function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("trigger", componentSchema, componentModules);
  return t;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("DEMO_ENABLED", "true");
  vi.stubEnv("TRIGGER_SECRET_KEY", "test-only");
  vi.stubEnv("DEMO_ARTIFACT_SECRET", "d".repeat(64));
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("TURNSTILE_SITE_KEY", undefined);
  vi.stubEnv("TURNSTILE_SECRET_KEY", undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function finish(t: ReturnType<typeof setup>, id: string, output?: unknown) {
  const job = await t.run((ctx) => ctx.db.get(id as Id<"edits">));
  if (!job?.componentRunId) throw new Error("Job missing");
  await t.mutation(internal.jobs.complete, {
    run: {
      id: job.componentRunId,
      taskId: "convex-edit-image",
      status: output ? "COMPLETED" : "FAILED",
      syncStatus: "complete",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(output ? { output } : {}),
    },
  });
}
const board = (t: ReturnType<typeof setup>, sessionToken = OWNER) =>
  t.query(api.jobs.board, { sessionToken });

test("jobs and cached requests are private to their browser session", async () => {
  const t = setup();
  const first = await t.action(api.jobs.process, args);
  expect(await t.action(api.jobs.process, args)).toEqual({ jobId: first.jobId, cached: true });
  expect((await board(t)).jobs.map((job) => job.prompt)).toEqual([args.prompt]);
  expect((await board(t, OTHER)).jobs).toEqual([]);
  await expect(t.query(api.jobs.board, { sessionToken: "guessable" })).rejects.toThrow(
    "Invalid browser session"
  );
  await expect(t.action(api.jobs.process, { ...args, prompt: "different edit" })).rejects.toThrow(
    "different edits"
  );
  await finish(t, first.jobId);
  vi.setSystemTime(Date.now() + COOLDOWN_MS);
  const second = await t.action(api.jobs.process, { ...args, sessionToken: OTHER });
  expect(second.cached).toBe(false);
  expect(second.jobId).not.toBe(first.jobId);
  expect((await board(t, OTHER)).jobs).toHaveLength(1);
});

test("Realtime credentials and refresh require ownership, and legacy runs stay polling-only", async () => {
  const t = setup();
  const first = await t.action(api.jobs.process, args);
  const input = { jobId: first.jobId as Id<"edits">, sessionToken: OTHER };
  await expect(t.action(api.realtime.token, input)).rejects.toThrow("Job not found");
  await expect(t.mutation(api.jobs.refresh, input)).rejects.toThrow("Job not found");
  await t.run((ctx) => ctx.db.patch(input.jobId, { realtimeEligible: undefined }));
  expect(await t.action(api.realtime.token, { ...input, sessionToken: OWNER })).toBeNull();
  await t.mutation(api.jobs.refresh, { ...input, sessionToken: OWNER });
  expect((await board(t)).quota.used).toBe(1);
});

test("global lifetime and daily budgets cannot be reset with another session", async () => {
  const t = setup();
  await t.run((ctx) =>
    ctx.db.insert("launchControl", { used: 4, modelUsed: MAX_JOBS - 1, lastLaunchAt: 0 })
  );
  const first = await t.action(api.jobs.process, args);
  await finish(t, first.jobId);
  vi.setSystemTime(Date.now() + COOLDOWN_MS);
  await expect(t.action(api.jobs.process, { ...args, sessionToken: OTHER })).rejects.toThrow(
    "lifetime generation budget"
  );
  expect((await board(t)).quota.used).toBe(MAX_JOBS);
  const daily = setup();
  await daily.run((ctx) =>
    ctx.db.insert("launchControl", {
      used: 4,
      modelUsed: 0,
      dayStart: Math.floor(Date.now() / DAY_MS) * DAY_MS,
      dayUsed: DAILY_JOB_LIMIT,
      lastLaunchAt: 0,
    })
  );
  await expect(daily.action(api.jobs.process, args)).rejects.toThrow("Today's generation budget");
  vi.setSystemTime(Date.now() + DAY_MS);
  await daily.action(api.jobs.process, args);
  expect((await board(daily)).quota.dailyUsed).toBe(1);
});

test("active-job fencing, cooldown and the kill switch prevent extra paid work", async () => {
  const t = setup();
  const first = await t.action(api.jobs.process, args);
  await expect(
    t.action(api.jobs.process, { ...args, requestId: "request-other", prompt: "Make it summer" })
  ).rejects.toThrow("Another background job");
  await finish(t, first.jobId);
  await expect(t.action(api.jobs.process, { ...args, requestId: "request-other" })).rejects.toThrow(
    "cooldown"
  );
  vi.setSystemTime(Date.now() + COOLDOWN_MS);
  await t.action(api.jobs.process, { ...args, requestId: "request-second" });
  await finish(t, first.jobId);
  expect((await board(t)).quota.active).toBe(true);
  vi.stubEnv("DEMO_ENABLED", "false");
  await expect(
    t.action(api.jobs.process, { ...args, requestId: "request-disabled", prompt: "New edit" })
  ).rejects.toThrow("paused");
  expect(await t.action(api.jobs.process, args)).toEqual({ jobId: first.jobId, cached: true });
  expect((await board(t)).quota.used).toBe(2);
});

test("private HTTP artifacts reject other sessions and expire with intermediate files cleaned up", async () => {
  const t = setup();
  const first = await t.action(api.jobs.process, args);
  const WORKER = await jobWorkerToken("d".repeat(64), first.jobId);
  const path = (slot: string, endpoint = "artifacts") =>
    `/${endpoint}?jobId=${first.jobId}&slot=${slot}`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  expect((await t.fetch(path("prepared"))).status).toBe(401);
  expect(
    (
      await t.fetch(path("prepared"), {
        method: "POST",
        headers: { ...auth(OWNER), "Content-Type": "image/jpeg" },
        body: "input",
      })
    ).status
  ).toBe(404);
  expect(
    (
      await t.fetch(path("prepared"), {
        method: "POST",
        headers: { ...auth(WORKER), "Content-Type": "image/jpeg" },
        body: "input",
      })
    ).status
  ).toBe(201);
  expect((await t.fetch(path("prepared"), { headers: auth(OWNER) })).status).toBe(404);
  const bytes = "private avif fixture";
  for (const variant of VARIANTS) {
    expect(
      (
        await t.fetch(path(variant.kind), {
          method: "POST",
          headers: { ...auth(WORKER), "Content-Type": "image/avif" },
          body: bytes,
        })
      ).status
    ).toBe(201);
  }
  await finish(t, first.jobId, {
    inputBytes: 100,
    processingMs: 1000,
    variants: VARIANTS.map((variant) => ({
      kind: variant.kind,
      width: variant.width,
      height: variant.height,
      bytes: bytes.length,
      format: "avif",
    })),
  });
  expect((await t.fetch(path("prepared"), { headers: auth(WORKER) })).status).toBe(404);
  const response = await t.fetch(path("hero", "image"), { headers: auth(OWNER) });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(await response.text()).toBe(bytes);
  expect((await t.fetch(path("hero", "image"), { headers: auth(OTHER) })).status).toBe(404);
  vi.setSystemTime(Date.now() + RESULT_TTL_MS);
  await t.mutation(internal.jobs.expire, { jobId: first.jobId as Id<"edits"> });
  expect((await board(t)).jobs).toEqual([]);
  expect((await t.fetch(path("hero", "image"), { headers: auth(OWNER) })).status).toBe(404);
});

test("invalid completed output fails visibly and releases the active reservation", async () => {
  const t = setup();
  const first = await t.action(api.jobs.process, args);
  await finish(t, first.jobId, { variants: [] });
  const state = await board(t);
  expect(state.jobs[0]?.status).toBe("FAILED");
  expect(state.jobs[0]?.error).toContain("could not be verified");
  expect(state.quota.active).toBe(false);
});

test("the storage sweep collects unregistered files left by interrupted uploads", async () => {
  const t = setup();
  const id = await t.run((ctx) => ctx.storage.store(new Blob(["orphan"], { type: "image/png" })));
  await t.mutation(internal.jobs.sweepStorage, {});
  expect(await t.run(async (ctx) => (await ctx.storage.get(id)) !== null)).toBe(true);
  vi.setSystemTime(Date.now() + RESULT_TTL_MS + 1);
  await t.mutation(internal.jobs.sweepStorage, {});
  expect(await t.run(async (ctx) => (await ctx.storage.get(id)) === null)).toBe(true);
});

test("configured human verification fails closed before reserving any generation", async () => {
  const t = setup();
  vi.stubEnv("TURNSTILE_SITE_KEY", "test-site");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "attacker.example" }))
  );
  await expect(
    t.action(api.jobs.process, { ...args, challengeToken: "challenge" })
  ).rejects.toThrow("Human verification failed");
  expect((await board(t)).quota.used).toBe(0);
});
