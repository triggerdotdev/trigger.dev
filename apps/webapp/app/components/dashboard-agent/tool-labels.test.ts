import { dashboardAgentCodeToolSchemas } from "@internal/dashboard-agent/tool-schemas";
import { describe, expect, it } from "vitest";
import { toolPendingLabel } from "./tool-labels";

describe("toolPendingLabel", () => {
  it("names every tool the agent can call", () => {
    const unnamed = Object.keys(dashboardAgentCodeToolSchemas).filter((name) =>
      toolPendingLabel(name).startsWith("Running ")
    );
    // `run_query` is the exception: "Running a query" is its phrase, not a fallback.
    expect(unnamed).toEqual(["run_query"]);
  });

  it("falls back to the tool name for a tool it doesn't know", () => {
    expect(toolPendingLabel("get_queue_health")).toBe("Running get_queue_health");
  });

  it("reads as a phrase, not an identifier", () => {
    expect(toolPendingLabel("get_run")).toBe("Reading the run");
    expect(toolPendingLabel("render_view")).toBe("Rendering a card");
    expect(toolPendingLabel("get_report")).not.toMatch(/…$/);
  });
});
