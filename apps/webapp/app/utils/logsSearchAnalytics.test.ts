import { describe, expect, it } from "vitest";
import { LogsSearchAnalytics, logsSearchKey, type LogsSearchEvent } from "./logsSearchAnalytics";

function setup() {
  const events: { event: LogsSearchEvent; properties: Record<string, unknown> }[] = [];
  let time = 0;
  let id = 0;
  const analytics = new LogsSearchAnalytics(
    (event, properties) => events.push({ event, properties }),
    () => time,
    () => `search-${++id}`
  );
  return {
    analytics,
    events,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const emptySlice = {
  resultCount: 0,
  complete: false,
  timedOut: false,
  stopped: false,
  expired: false,
};

describe("logs search analytics", () => {
  it("emits one start and initial result across automatic slices without sending content", () => {
    const { analytics, events, advance } = setup();
    const search = "?search=private@example.com&tasks=private-task&runId=run_secret&period=7d";
    analytics.start("key", search);
    analytics.start("key", search);
    analytics.response("key", { ...emptySlice, timedOut: true, rangeDurationMs: 7 * 86400_000 });
    analytics.response("key", emptySlice);
    advance(240);
    analytics.response("key", { ...emptySlice, resultCount: 5 });
    analytics.response("key", { ...emptySlice, resultCount: 10, complete: true });
    expect(events.map(({ event }) => event)).toEqual(["logs_search_started", "logs_search_result"]);
    expect(events[0].properties).toMatchObject({
      search_kind: "id",
      has_task_filter: true,
      has_run_filter: true,
    });
    expect(events[1].properties).toMatchObject({
      phase: "initial",
      outcome: "results",
      time_range_bucket: "up_to_7d",
      first_batch_result_count: 5,
      range_complete: false,
      timeout_count: 1,
      elapsed_ms: 240,
    });
    expect(JSON.stringify(events)).not.toMatch(/private|example|run_secret/);
  });

  it("distinguishes complete empty searches from paused and failed searches", () => {
    for (const outcome of [
      "no_matches",
      "budget_exhausted",
      "error",
      "timeout",
      "expired",
    ] as const) {
      const { analytics, events } = setup();
      analytics.start("key", "");
      if (outcome === "no_matches") analytics.response("key", { ...emptySlice, complete: true });
      else if (outcome === "timeout")
        analytics.response("key", { ...emptySlice, timedOut: true, stopped: true });
      else if (outcome === "expired") analytics.response("key", { ...emptySlice, expired: true });
      else analytics.result("key", outcome);
      expect(events[1].properties).toMatchObject({
        outcome,
        range_complete: outcome === "no_matches",
      });
    }
  });

  it("records failures after the initial result, without emitting events for normal slices", () => {
    const { analytics, events } = setup();
    analytics.start("key", "");
    analytics.response("key", { ...emptySlice, resultCount: 5 });
    analytics.response("key", { ...emptySlice, resultCount: 10 });
    analytics.result("key", "error");
    analytics.result("key", "error");
    analytics.action("retry");
    analytics.result("key", "error");
    analytics.action("continue_search");
    analytics.response("key", { ...emptySlice, timedOut: true, stopped: true });
    expect(events.map(({ properties }) => properties.outcome ?? properties.action)).toEqual([
      undefined,
      "results",
      "error",
      "retry",
      "error",
      "continue_search",
      "timeout",
    ]);
    expect(events[2].properties).toMatchObject({
      phase: "continuation",
      search_id: events[0].properties.search_id,
    });
    expect(events[2].properties).not.toHaveProperty("first_batch_result_count");
  });

  it("rejects stale responses and correlates replacement and engagement actions", () => {
    const { analytics, events } = setup();
    analytics.start("/logs?search=first", "?search=first");
    analytics.start("/logs?search=second", "?search=second");
    analytics.response("/logs?search=first", { ...emptySlice, complete: true });
    analytics.action("open_result", "/logs?search=first");
    analytics.response("/logs?search=second", { ...emptySlice, resultCount: 1 });
    analytics.action("open_result");
    analytics.action("expand_range");
    analytics.start("/logs?search=second&period=7d", "?search=second&period=7d");
    analytics.leave();
    analytics.leave();
    expect(
      events.map(
        ({ properties }) => properties.action ?? properties.entry_point ?? properties.outcome
      )
    ).toEqual([
      "route_mount",
      "replace_unfinished_search",
      "new_search",
      "results",
      "open_result",
      "expand_range",
      "expand_range",
      "cancel",
    ]);
    expect(events[1].properties.search_id).toBe(events[0].properties.search_id);
    expect(events[4].properties.search_id).toBe(events[3].properties.search_id);
  });

  it("labels route mounts honestly and uses observed navigation timing when available", () => {
    const { analytics, events, advance } = setup();
    analytics.start("mounted", "");
    analytics.response("mounted", { ...emptySlice, queryElapsedMs: 500, resultCount: 1 });
    expect(events[1].properties).toMatchObject({ timing_origin: "route_mount", elapsed_ms: 500 });
    analytics.start("navigated", "?search=error", 0);
    advance(200);
    analytics.response("navigated", { ...emptySlice, queryElapsedMs: 100, resultCount: 1 });
    expect(events[3].properties).toMatchObject({ timing_origin: "navigation", elapsed_ms: 200 });
  });

  it("buckets the presenter's effective range instead of interpreting URL filters", () => {
    for (const [search, duration, expected] of [
      ["?to=1", -1, "empty"],
      ["?period=1h&from=1&to=9999999999999", 3600_000, "up_to_1h"],
      ["?period=30d", 7 * 86400_000, "up_to_7d"],
    ] as const) {
      const { analytics, events } = setup();
      analytics.start("key", search);
      analytics.response("key", { ...emptySlice, complete: true, rangeDurationMs: duration });
      expect(events[1].properties.time_range_bucket).toBe(expected);
    }
  });

  it("distinguishes context changes and ignores detail selection and cursors", () => {
    const { analytics, events } = setup();
    const path = "/orgs/example/projects/project/env/prod/logs";
    analytics.start(logsSearchKey(path, ""), "");
    analytics.response(logsSearchKey(path, ""), { ...emptySlice, complete: true });
    analytics.start(logsSearchKey(path.replace("prod", "dev"), ""), "");
    expect(events[2].properties.entry_point).toBe("context_change");
    expect(logsSearchKey(path, "?search=error&period=1d&log=secret&cursor=secret")).toBe(
      logsSearchKey(path, "?period=1d&search=error")
    );
  });
});
