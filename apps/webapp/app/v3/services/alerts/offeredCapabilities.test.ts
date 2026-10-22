import { listCapabilities } from "@internal/alert-contracts";
import { describe, expect, it } from "vitest";
import { scenarioStep } from "~/components/alerts/wizardSteps";
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
});
