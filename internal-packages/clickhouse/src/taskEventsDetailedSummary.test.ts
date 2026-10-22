import { describe, expect, it } from "vitest";
import { NoopClient } from "./client/noop.js";
import {
  getTraceDetailedSummaryQueryBuilder,
  getTraceDetailedSummaryQueryBuilderV2,
} from "./taskEvents.js";

describe("trace detailed summary query builders", () => {
  it.each([
    ["task_events_v1", getTraceDetailedSummaryQueryBuilder],
    ["task_events_v2", getTraceDetailedSummaryQueryBuilderV2],
  ])("%s does not select attributes_text (the tree builder never reads it)", (table, builder) => {
    const { query } = builder(new NoopClient())().build();

    expect(query).toMatch(new RegExp(`^SELECT .+ FROM trigger_dev\\.${table}$`));
    expect(query).not.toContain("attributes_text");
  });
});
