import { listCapabilities } from "@internal/alert-contracts";
import { describe, expect, it } from "vitest";
import { allSteps, scenarioStep } from "~/components/alerts/wizardSteps";
import { filterOfferedCapabilities } from "./offeredCapabilities";

const caps = listCapabilities({ surface: "agent" });

describe("offered capabilities", () => {
  it("hides queue capabilities and the queues area when queue metrics are off", () => {
    const offered = filterOfferedCapabilities(caps, false);
    expect(offered.some((c) => c.key.startsWith("queue."))).toBe(false);
    expect(offered.some((c) => c.area === "queues")).toBe(false);
    expect(offered.length).toBeGreaterThan(0);
  });

  it("offers queue capabilities when queue metrics are on", () => {
    const offered = filterOfferedCapabilities(caps, true);
    expect(offered.some((c) => c.key === "queue.depth")).toBe(true);
    expect(offered).toEqual(caps);
  });

  it("drops queues from the scenario list when hidden", () => {
    expect(scenarioStep(["queues"]).options.some((o) => o.id.startsWith("queues:"))).toBe(false);
    expect(scenarioStep().options.some((o) => o.id.startsWith("queues:"))).toBe(true);
  });

  it("keeps empty areas listed but disabled with a hint", () => {
    const hint = "No tasks in this environment yet";
    const area = allSteps({ answers: {} } as any, [], undefined, undefined, undefined, undefined, [
      "runs",
    ]).find((s) => s.id === "area")!;
    const runs = area.options.find((o) => o.id === "runs")!;
    expect(runs.disabledReason).toBe(hint);
    expect(area.options.find((o) => o.id === "health")!.disabledReason).toBeUndefined();

    const rows = scenarioStep([], ["runs"]).options.filter((o) => o.id.startsWith("runs:"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((o) => o.disabledReason === hint)).toBe(true);
  });

  it("keeps a chosen hidden area but offers none of its capabilities", () => {
    const steps = allSteps(
      { answers: { area: "queues" } } as any,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      ["queues"]
    );
    expect(steps.find((s) => s.id === "area")!.options.some((o) => o.id === "queues")).toBe(true);
    expect(steps.find((s) => s.id === "what")!.options.map((o) => o.id)).toEqual(["__show_all__"]);
  });
});
