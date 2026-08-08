import {
  SUGGESTED_PROMPT_CAP,
  type AgentPage,
  type AgentPageKind,
  type SuggestedPrompt,
} from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import { demoFreshFailureSignal, demoPageContexts } from "../demo/fixtures/page-context";
import { GENERIC_PROMPTS, pageDefaultPrompts, pageSlotPrompts } from "./registry";
import { makeSuggestedPromptResolver, resolveSuggestedPrompts } from "./resolver";

/** Fixed clock: "failed 12 minutes after the fixture's failedAt". */
const NOW = Date.parse("2026-07-27T10:25:41.000Z");

const promoted: SuggestedPrompt = {
  id: "sp:promo-blackfriday",
  label: "Check the Black Friday queue",
  prompt: "How is the black-friday queue holding up?",
  source: "default", // deliberately wrong: the resolver must force `promoted`
};

const ids = (prompts: SuggestedPrompt[]) => prompts.map((p) => p.id);

const docsId = (key: keyof typeof demoPageContexts) =>
  pageSlotPrompts(demoPageContexts[key].page).docs.id;

describe("resolveSuggestedPrompts", () => {
  it("fills all five slots when the page has a promoted chip, signals and defaults", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.error, { promoted, now: NOW });

    expect(prompts).toHaveLength(5);
    expect(ids(prompts)).toEqual([
      promoted.id,
      "sp:fresh-failure",
      "sp:error-watch-recurrence",
      "sp:error-similar",
      docsId("error"),
    ]);
    expect(prompts[0]?.source).toBe("promoted");
  });

  it("drops to four slots when nothing is promoted", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.error, { now: NOW });

    expect(prompts).toHaveLength(4);
    expect(ids(prompts)).toEqual([
      "sp:fresh-failure",
      "sp:error-watch-recurrence",
      "sp:error-similar",
      docsId("error"),
    ]);
  });

  it("shows explain + docs only when no investigate or watch applies", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.deployment, { now: NOW });

    expect(ids(prompts)).toEqual(ids(pageDefaultPrompts(demoPageContexts.deployment.page)));
    expect(prompts).toHaveLength(2);
    expect(prompts.every((p) => p.source === "default")).toBe(true);
  });

  it("falls back to the generic explain + docs pair for an unclassified page", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.other, { now: NOW });

    expect(ids(prompts)).toEqual(ids(GENERIC_PROMPTS));
    expect(prompts.every((p) => p.source === "default")).toBe(true);
  });

  it("always puts the docs chip last, on every page kind", () => {
    for (const [key, context] of Object.entries(demoPageContexts)) {
      const prompts = resolveSuggestedPrompts(context, { promoted, now: NOW });
      const last = prompts.at(-1);

      expect(last?.id, key).toBe(docsId(key as keyof typeof demoPageContexts));
      expect(
        prompts.filter((p) => p.id === last?.id),
        key
      ).toHaveLength(1);
    }
  });

  it("orders promoted, then investigate, then watch, then explain", () => {
    const context = {
      ...demoPageContexts.queue,
      signals: [...demoPageContexts.queue.signals, demoFreshFailureSignal],
    };

    const prompts = resolveSuggestedPrompts(context, { promoted, now: NOW });

    expect(ids(prompts)).toEqual([
      promoted.id,
      "sp:fresh-failure",
      // waiting_run beats concurrency_saturation for the watch slot.
      "sp:waiting-run",
      "sp:queue-state",
      docsId("queue"),
    ]);
  });

  it("gives a signal chip the slot ahead of the page-kind default", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.failedRun, { now: NOW });

    expect(prompts[0]?.id).toBe("sp:fresh-failure");
    expect(prompts[0]?.source).toBe("contextual");
    expect(ids(prompts)).not.toContain("sp:run-investigate");
  });

  it("never returns more than the cap", () => {
    for (const context of Object.values(demoPageContexts)) {
      const prompts = resolveSuggestedPrompts(context, { promoted, now: NOW });
      expect(prompts.length).toBeLessThanOrEqual(SUGGESTED_PROMPT_CAP);
      expect(prompts.length).toBeGreaterThan(0);
    }
  });

  it("promotes the next candidate for a slot when its chip is dismissed", () => {
    const full = resolveSuggestedPrompts(demoPageContexts.failedRun, { now: NOW });
    const dismissed = resolveSuggestedPrompts(demoPageContexts.failedRun, {
      now: NOW,
      dismissedIds: ["sp:fresh-failure"],
    });

    expect(ids(full)[0]).toBe("sp:fresh-failure");
    expect(ids(dismissed)[0]).toBe("sp:run-investigate");
    expect(dismissed).toHaveLength(full.length);
  });

  it("collapses a slot with nothing left to offer", () => {
    const full = resolveSuggestedPrompts(demoPageContexts.error, { now: NOW });
    const dismissed = resolveSuggestedPrompts(demoPageContexts.error, {
      now: NOW,
      dismissedIds: ["sp:error-watch-recurrence"],
    });

    expect(ids(dismissed)).not.toContain("sp:error-watch-recurrence");
    expect(dismissed).toHaveLength(full.length - 1);
    expect(dismissed.at(-1)?.id).toBe(docsId("error"));
  });

  it("can have the promoted chip dismissed like any other", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.runs, {
      promoted,
      now: NOW,
      dismissedIds: [promoted.id],
    });

    expect(ids(prompts)).not.toContain(promoted.id);
  });

  it("de-duplicates a chip that is both a default and the promoted slot", () => {
    const explain = pageSlotPrompts(demoPageContexts.other.page).explain;
    const prompts = resolveSuggestedPrompts(demoPageContexts.other, {
      promoted: { ...explain, source: "default" },
      now: NOW,
    });

    expect(ids(prompts).filter((id) => id === explain.id)).toHaveLength(1);
    expect(prompts[0]?.source).toBe("promoted");
  });

  it("sends the full prompt text, not the short label", () => {
    const [failure] = resolveSuggestedPrompts(demoPageContexts.failedRun, { now: NOW });

    expect(failure?.label).toBe("Why did this run fail?");
    expect(failure?.prompt).toContain(
      demoPageContexts.failedRun.page.kind === "run" ? demoPageContexts.failedRun.page.runId : ""
    );
    expect(failure?.prompt).toContain("12m ago");
  });

  it("words the waiting-run and slow-run chips for their slots", () => {
    const waiting = resolveSuggestedPrompts(demoPageContexts.waitingRun, { now: NOW });
    const waitingChip = waiting.find((p) => p.id === "sp:waiting-run");
    expect(waitingChip?.label).toBe("Tell me when this run starts");
    expect(waitingChip?.prompt).toContain("queue");

    const slow = resolveSuggestedPrompts(demoPageContexts.slowRun, { now: NOW });
    expect(slow[0]?.label).toBe("~7.8x slower than usual");
  });

  it("skips a slow_run signal with no usable baseline", () => {
    const prompts = resolveSuggestedPrompts(
      {
        page: { kind: "other", path: "/whatever" },
        signals: [{ kind: "slow_run", runId: "run_x", durationMs: 5000, baselineP95Ms: 0 }],
      },
      { now: NOW }
    );

    expect(ids(prompts)).toEqual(ids(GENERIC_PROMPTS));
  });

  it("exposes the contract's resolver shape with options bound", () => {
    const resolver = makeSuggestedPromptResolver({ promoted, now: NOW });
    expect(resolver(demoPageContexts.failedRun)[0]?.id).toBe(promoted.id);
  });
});

describe("pageSlotPrompts", () => {
  it("gives every page kind an explain and a docs chip", () => {
    for (const context of Object.values(demoPageContexts)) {
      const slots = pageSlotPrompts(context.page);
      expect(slots.explain.label, context.page.kind).toBeTruthy();
      expect(slots.docs.label, context.page.kind).toBeTruthy();
    }
  });

  it("gives every page kind a non-empty, uniquely-identified default set", () => {
    for (const context of Object.values(demoPageContexts)) {
      const prompts = pageDefaultPrompts(context.page);
      expect(prompts.length, context.page.kind).toBeGreaterThan(0);
      expect(new Set(ids(prompts)).size, context.page.kind).toBe(prompts.length);
      expect(prompts.at(-1)?.id, context.page.kind).toBe(pageSlotPrompts(context.page).docs.id);
    }
  });

  it("gives the list pages their own explain and docs, not the generic pair", () => {
    for (const kind of ["errors", "queues", "deployments"] as const) {
      const slots = pageSlotPrompts({ kind });
      expect(slots.explain.id, kind).not.toBe(GENERIC_PROMPTS[0]!.id);
      expect(slots.docs.id, kind).not.toBe(GENERIC_PROMPTS[1]!.id);
      expect(slots.investigate, kind).toBeUndefined();
    }
  });

  it("offers a queue investigate chip only when the queue is unhealthy", () => {
    const healthy = pageSlotPrompts({ kind: "queue", name: "emails", health: "ok" });
    expect(healthy.investigate).toBeUndefined();

    for (const health of ["warn", "crit"] as const) {
      const slots = pageSlotPrompts({ kind: "queue", name: "emails", health });
      expect(slots.investigate?.prompt, health).toBe(
        "Investigate the emails queue — why is it backed up?"
      );
    }
  });

  it("offers a paused queue neither chip, however unhealthy it looks", () => {
    // Paused reads as `warn`, so without the guard the backlog chips would both appear —
    // asking why a queue someone paused is backed up, and offering to watch it drain.
    const slots = pageSlotPrompts({ kind: "queue", name: "emails", health: "warn", paused: true });

    expect(slots.investigate).toBeUndefined();
    expect(slots.watch).toBeUndefined();
    // The page is still explainable; only the two backlog asks are withheld.
    expect(slots.explain).toBeDefined();
  });

  it("offers a deployment investigate chip only for a deploy that didn't land", () => {
    expect(pageSlotPrompts({ kind: "deployment", version: "1.0" }).investigate).toBeUndefined();
    expect(
      pageSlotPrompts({ kind: "deployment", version: "1.0", status: "DEPLOYED" }).investigate
    ).toBeUndefined();
    expect(
      pageSlotPrompts({ kind: "deployment", version: "1.0", status: "CANCELED" }).investigate
    ).toBeUndefined();

    for (const status of ["FAILED", "TIMED_OUT"]) {
      const slots = pageSlotPrompts({ kind: "deployment", version: "20260727.1", status });
      expect(slots.investigate?.prompt, status).toContain("20260727.1");
    }
  });

  it("names the error page's subject in words, since a fingerprint is a hash", () => {
    const slots = pageSlotPrompts({ kind: "error", fingerprint: "9f2c1a" });
    expect(slots.investigate?.prompt).toContain("keep coming back");
  });

  it("mentions the page's own subject where the page has one", () => {
    const runPage = demoPageContexts.failedRun.page;
    if (runPage.kind !== "run") throw new Error("fixture changed");
    expect(pageDefaultPrompts(runPage).some((p) => p.prompt.includes(runPage.runId))).toBe(true);
    expect(pageDefaultPrompts(runPage).some((p) => p.prompt.includes(runPage.taskId))).toBe(true);

    const queuePage = demoPageContexts.queue.page;
    if (queuePage.kind !== "queue") throw new Error("fixture changed");
    expect(pageDefaultPrompts(queuePage).some((p) => p.prompt.includes(queuePage.name))).toBe(true);
  });
});

/** Keyed by `AgentPageKind`: a new kind without chips is a type error here. */
const SAMPLE_PAGES: Record<AgentPageKind, AgentPage> = {
  runs: { kind: "runs" },
  run: { kind: "run", runId: "run_1", status: "Executing", taskId: "process-order" },
  errors: { kind: "errors" },
  error: { kind: "error", fingerprint: "9f2c1a" },
  queues: { kind: "queues" },
  queue: { kind: "queue", name: "orders", health: "ok" },
  deployments: { kind: "deployments" },
  deployment: { kind: "deployment", version: "20260803.1", status: "DEPLOYED" },
  tasks: { kind: "tasks" },
  task: { kind: "task", taskId: "process-order", triggerSource: "STANDARD" },
  schedule: { kind: "schedule", scheduleId: "sched_1", taskId: "nightly", active: true },
  batches: { kind: "batches" },
  batch: { kind: "batch", batchId: "batch_1", status: "COMPLETED", failedRunCount: 0 },
  test: { kind: "test", taskId: "process-order", queuePaused: false },
  alerts: { kind: "alerts", channelCount: 2, disabledChannelCount: 0 },
  apikeys: { kind: "apikeys" },
  envvars: { kind: "envvars" },
  concurrency: { kind: "concurrency" },
  regions: { kind: "regions" },
  settings: { kind: "settings" },
  waitpoints: { kind: "waitpoints", timedOutCount: 0, overdueCount: 0 },
  bulkactions: { kind: "bulkactions", pendingCount: 0 },
  branches: { kind: "branches", atLimit: false },
  logs: { kind: "logs" },
  limits: { kind: "limits" },
  query: { kind: "query" },
  dashboards: { kind: "dashboards", title: "Run metrics" },
  agents: { kind: "agents", agentId: "support-triage" },
  playground: { kind: "playground" },
  prompts: { kind: "prompts", overriddenCount: 0 },
  models: { kind: "models" },
  sessions: { kind: "sessions", expiredCount: 0 },
  other: { kind: "other", path: "/orgs/a/projects/b/env/prod/nowhere" },
};

const ALL_PAGES = Object.values(SAMPLE_PAGES);

describe("pageSlotPrompts, across every page kind", () => {
  it.each(ALL_PAGES.map((page) => [page.kind, page] as const))(
    "gives %s an explain and a docs chip",
    (_kind, page) => {
      const slots = pageSlotPrompts(page);
      expect(slots.explain.label).toBeTruthy();
      expect(slots.explain.prompt).toBeTruthy();
      expect(slots.docs.label).toBeTruthy();
      expect(slots.docs.prompt).toBeTruthy();
    }
  );

  it("offers no investigate or status chip on a page where nothing is wrong", () => {
    for (const page of ALL_PAGES) {
      const slots = pageSlotPrompts(page);
      const inherentlyLoud = ["run", "error", "queue"];
      if (inherentlyLoud.includes(page.kind)) continue;
      expect(slots.investigate, page.kind).toBeUndefined();
      expect(slots.status, page.kind).toBeUndefined();
    }
  });

  it("puts docs last and keeps each page's ids unique", () => {
    for (const page of ALL_PAGES) {
      const prompts = pageDefaultPrompts(page);
      expect(prompts.length, page.kind).toBeGreaterThan(0);
      expect(new Set(prompts.map((p) => p.id)).size, page.kind).toBe(prompts.length);
      expect(prompts.at(-1)?.id, page.kind).toBe(pageSlotPrompts(page).docs.id);
    }
  });

  it("never reuses one chip id for two different questions", () => {
    // Dismissals are stored by id, so one id must mean the same chip everywhere.
    const byId = new Map<string, string>();
    for (const page of ALL_PAGES) {
      for (const prompt of pageDefaultPrompts(page)) {
        const seen = byId.get(prompt.id);
        if (seen !== undefined) expect(prompt.prompt, `${prompt.id} on ${page.kind}`).toBe(seen);
        byId.set(prompt.id, prompt.prompt);
      }
    }
  });

  it("gives every section its own chips rather than the generic pair", () => {
    for (const page of ALL_PAGES) {
      if (page.kind === "other") continue;
      const slots = pageSlotPrompts(page);
      expect(slots.explain.id, page.kind).not.toBe(GENERIC_PROMPTS[0]!.id);
      expect(slots.docs.id, page.kind).not.toBe(GENERIC_PROMPTS[1]!.id);
    }
  });
});

describe("pageSlotPrompts, the gated chips", () => {
  it("offers a task investigate chip only when the task can't run", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.task).investigate).toBeUndefined();

    const noSchedules = pageSlotPrompts({
      kind: "task",
      taskId: "nightly",
      triggerSource: "SCHEDULED",
      schedules: { total: 0, active: 0 },
    });
    expect(noSchedules.investigate?.id).toBe("sp:task-no-schedules");
    expect(noSchedules.investigate?.prompt).toContain("nightly");

    const allOff = pageSlotPrompts({
      kind: "task",
      taskId: "nightly",
      triggerSource: "SCHEDULED",
      schedules: { total: 2, active: 0 },
    });
    expect(allOff.investigate?.id).toBe("sp:task-schedules-disabled");

    const oneOn = pageSlotPrompts({
      kind: "task",
      taskId: "nightly",
      triggerSource: "SCHEDULED",
      schedules: { total: 2, active: 1 },
    });
    expect(oneOn.investigate).toBeUndefined();

    const paused = pageSlotPrompts({
      kind: "task",
      taskId: "process-order",
      queue: "orders",
      queuePaused: true,
    });
    expect(paused.investigate?.id).toBe("sp:task-queue-paused");
    expect(paused.investigate?.prompt).toContain("orders");

    const both = pageSlotPrompts({
      kind: "task",
      taskId: "nightly",
      triggerSource: "SCHEDULED",
      queue: "orders",
      queuePaused: true,
      schedules: { total: 0, active: 0 },
    });
    expect(both.investigate?.id).toBe("sp:task-no-schedules");
  });

  it("points a scheduled task at the schedules docs", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.task).docs.id).toBe("sp:docs-tasks");
    expect(
      pageSlotPrompts({ kind: "task", taskId: "nightly", triggerSource: "SCHEDULED" }).docs.id
    ).toBe("sp:docs-schedules");
  });

  it("offers a schedule investigate chip only when the schedule is disabled", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.schedule).investigate).toBeUndefined();

    const disabled = pageSlotPrompts({
      kind: "schedule",
      scheduleId: "sched_1",
      taskId: "nightly",
      active: false,
    });
    expect(disabled.investigate?.prompt).toContain("sched_1");
    expect(disabled.investigate?.prompt).toContain("nightly");
  });

  it("offers a batches investigate chip only when the newest batch failed", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.batches).investigate).toBeUndefined();

    const failed = pageSlotPrompts({ kind: "batches", latestFailedBatchId: "batch_9" });
    expect(failed.investigate?.prompt).toContain("batch_9");
  });

  it("words the batch chips off the batch's status and failure count", () => {
    const clean = pageSlotPrompts(SAMPLE_PAGES.batch);
    expect(clean.investigate).toBeUndefined();
    expect(clean.status).toBeUndefined();

    const partial = pageSlotPrompts({
      kind: "batch",
      batchId: "batch_1",
      status: "PARTIAL_FAILED",
      failedRunCount: 3,
    });
    expect(partial.investigate?.prompt).toContain("3 of its runs failed");
    expect(partial.status).toBeUndefined();

    const running = pageSlotPrompts({ kind: "batch", batchId: "batch_1", status: "PROCESSING" });
    expect(running.status?.id).toBe("sp:batch-progress");
    expect(running.investigate).toBeUndefined();

    const both = pageSlotPrompts({
      kind: "batch",
      batchId: "batch_1",
      status: "PROCESSING",
      failedRunCount: 2,
    });
    expect(both.investigate?.id).toBe("sp:batch-failures");
    expect(both.status?.id).toBe("sp:batch-progress");
  });

  it("warns on the test page only when the queue is paused", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.test).investigate).toBeUndefined();
    expect(pageSlotPrompts({ kind: "test", queuePaused: true }).investigate?.id).toBe(
      "sp:test-queue-paused"
    );
  });

  it("asks a different explain question with and without a task under test", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.test).explain.prompt).toContain("process-order");
    expect(pageSlotPrompts({ kind: "test" }).explain.id).toBe("sp:test-what-to-trigger");
  });

  it("offers an alerts status chip only when a channel is switched off", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.alerts).status).toBeUndefined();
    expect(
      pageSlotPrompts({ kind: "alerts", channelCount: 2, disabledChannelCount: 1 }).status?.id
    ).toBe("sp:alerts-disabled-channel");
  });

  it("offers a waitpoint investigate chip only for tokens that won't complete", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.waitpoints).investigate).toBeUndefined();
    expect(
      pageSlotPrompts({ kind: "waitpoints", timedOutCount: 1, overdueCount: 0 }).investigate?.id
    ).toBe("sp:waitpoints-stuck");
    expect(
      pageSlotPrompts({ kind: "waitpoints", timedOutCount: 0, overdueCount: 2 }).investigate?.id
    ).toBe("sp:waitpoints-stuck");

    expect(
      pageSlotPrompts({ kind: "waitpoints", tokenId: "wp_1", status: "WAITING" }).investigate
    ).toBeUndefined();
    const timedOut = pageSlotPrompts({
      kind: "waitpoints",
      tokenId: "wp_1",
      status: "TIMED_OUT",
    });
    expect(timedOut.investigate?.prompt).toContain("wp_1");
  });

  it("words the bulk-action chips off the action's status and failures", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.bulkactions).status).toBeUndefined();
    expect(pageSlotPrompts({ kind: "bulkactions", pendingCount: 1 }).status?.id).toBe(
      "sp:bulkactions-pending"
    );

    const failed = pageSlotPrompts({
      kind: "bulkactions",
      bulkActionId: "bulk_1",
      status: "COMPLETED",
      failedRunCount: 4,
    });
    expect(failed.investigate?.prompt).toContain("bulk_1");
    expect(failed.status).toBeUndefined();

    const aborted = pageSlotPrompts({
      kind: "bulkactions",
      bulkActionId: "bulk_1",
      status: "ABORTED",
    });
    expect(aborted.investigate?.id).toBe("sp:bulkaction-failures");

    const pending = pageSlotPrompts({
      kind: "bulkactions",
      bulkActionId: "bulk_1",
      status: "PENDING",
    });
    expect(pending.status?.id).toBe("sp:bulkaction-progress");
    expect(pending.investigate).toBeUndefined();
  });

  it("offers a branches status chip only at the limit", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.branches).status).toBeUndefined();
    expect(pageSlotPrompts({ kind: "branches", atLimit: true }).status?.id).toBe(
      "sp:branches-at-limit"
    );
  });

  it("names the exhausted quota on the limits page", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.limits).status).toBeUndefined();
    expect(pageSlotPrompts({ kind: "limits", exhausted: [] }).status).toBeUndefined();
    expect(
      pageSlotPrompts({ kind: "limits", exhausted: ["Branches", "Schedules"] }).status?.prompt
    ).toContain("Branches");
  });

  it("offers a prompts status chip only when an override is live", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.prompts).status).toBeUndefined();
    expect(pageSlotPrompts({ kind: "prompts", overriddenCount: 2 }).status?.id).toBe(
      "sp:prompts-overrides"
    );

    expect(
      pageSlotPrompts({ kind: "prompts", slug: "summarise", overridden: false }).status
    ).toBeUndefined();
    expect(
      pageSlotPrompts({ kind: "prompts", slug: "summarise", overridden: true }).status?.prompt
    ).toContain("summarise");
  });

  it("offers a session investigate chip only when its run failed", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.sessions).investigate).toBeUndefined();
    expect(pageSlotPrompts({ kind: "sessions", expiredCount: 1 }).status?.id).toBe(
      "sp:sessions-expired"
    );

    const healthy = pageSlotPrompts({
      kind: "sessions",
      sessionId: "session_1",
      runId: "run_1",
      runStatus: "COMPLETED_SUCCESSFULLY",
    });
    expect(healthy.investigate).toBeUndefined();

    const failed = pageSlotPrompts({
      kind: "sessions",
      sessionId: "session_1",
      runId: "run_1",
      runStatus: "CRASHED",
    });
    expect(failed.investigate?.prompt).toContain("session_1");
    expect(failed.investigate?.prompt).toContain("run_1");
  });

  it("reads a named dashboard, and offers to chart something on the chooser", () => {
    expect(pageSlotPrompts(SAMPLE_PAGES.dashboards).explain.prompt).toContain("Run metrics");
    expect(pageSlotPrompts({ kind: "dashboards" }).explain.id).toBe("sp:dashboards-chart");
  });

  it("names the subject on the pages that have one", () => {
    const named: [AgentPage, string][] = [
      [{ kind: "agents", agentId: "support-triage" }, "support-triage"],
      [{ kind: "playground", agentId: "support-triage" }, "support-triage"],
      [{ kind: "models", modelId: "claude-sonnet-4-6" }, "claude-sonnet-4-6"],
      [{ kind: "prompts", slug: "summarise" }, "summarise"],
      [{ kind: "sessions", sessionId: "session_1" }, "session_1"],
      [{ kind: "batch", batchId: "batch_1" }, "batch_1"],
      [{ kind: "task", taskId: "process-order" }, "process-order"],
    ];

    for (const [page, subject] of named) {
      expect(
        pageDefaultPrompts(page).some((prompt) => prompt.prompt.includes(subject)),
        page.kind
      ).toBe(true);
    }
  });
});
