import { describe, expect, it } from "vitest";
import {
  buildDeliveryTimelineItems,
  type BuildDeliveryTimelineInput,
} from "~/components/webhookDeliveries/v1/buildDeliveryTimelineItems";

const createdAt = new Date("2026-07-13T10:32:04.120Z");
const processedAt = new Date("2026-07-13T10:32:05.320Z");

function baseDelivery(overrides: Partial<BuildDeliveryTimelineInput>): BuildDeliveryTimelineInput {
  return {
    status: "PENDING",
    createdAt,
    processedAt: null,
    errorMessage: null,
    filterReason: null,
    run: null,
    session: null,
    ...overrides,
  };
}

describe("buildDeliveryTimelineItems", () => {
  it("PENDING renders Received + an in-flight routing line, no terminal node", () => {
    const items = buildDeliveryTimelineItems(baseDelivery({ status: "PENDING" }));

    expect(items.map((i) => i.id)).toEqual(["received", "routing"]);
    const line = items[1];
    expect(line.type).toBe("line");
    expect(line).toMatchObject({ from: createdAt, to: null, state: "inprogress" });
  });

  it("PROCESSING is also in-flight (no terminal node)", () => {
    const items = buildDeliveryTimelineItems(baseDelivery({ status: "PROCESSING" }));

    expect(items.map((i) => i.id)).toEqual(["received", "routing"]);
    expect(items[1]).toMatchObject({ to: null, state: "inprogress" });
  });

  it("SUCCEEDED renders a Delivered terminal node with the run/session target", () => {
    const items = buildDeliveryTimelineItems(
      baseDelivery({
        status: "SUCCEEDED",
        processedAt,
        run: { friendlyId: "run_2f4b" },
        session: { friendlyId: "sess_xyz", externalId: "cust_1" },
      })
    );

    expect(items.map((i) => i.id)).toEqual(["received", "routing", "delivered"]);
    expect(items[1]).toMatchObject({ from: createdAt, to: processedAt, state: "complete" });
    const terminal = items[2];
    expect(terminal).toMatchObject({
      type: "event",
      title: "Delivered",
      state: "complete",
      date: processedAt,
      target: {
        run: { friendlyId: "run_2f4b" },
        session: { friendlyId: "sess_xyz", externalId: "cust_1" },
      },
    });
  });

  it("FAILED renders a Failed terminal node carrying the error message", () => {
    const items = buildDeliveryTimelineItems(
      baseDelivery({ status: "FAILED", processedAt, errorMessage: "queue limit exceeded" })
    );

    expect(items.map((i) => i.id)).toEqual(["received", "routing", "failed"]);
    expect(items[1]).toMatchObject({ state: "error" });
    expect(items[2]).toMatchObject({
      title: "Failed",
      state: "error",
      note: "queue limit exceeded",
    });
  });

  it("FILTERED renders a dimmed Filtered node with the reason and no run target", () => {
    const items = buildDeliveryTimelineItems(
      baseDelivery({
        status: "FILTERED",
        processedAt,
        filterReason: "action != opened",
      })
    );

    expect(items.map((i) => i.id)).toEqual(["received", "routing", "filtered"]);
    expect(items[1]).toMatchObject({ state: "delayed", variant: "light" });
    const terminal = items[2];
    expect(terminal).toMatchObject({
      type: "event",
      title: "Filtered",
      state: "delayed",
      note: "action != opened",
    });
    expect((terminal as { target?: unknown }).target).toBeUndefined();
  });

  it("Received is always the first node and marked complete", () => {
    for (const status of ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "FILTERED"] as const) {
      const items = buildDeliveryTimelineItems(baseDelivery({ status, processedAt }));
      expect(items[0]).toMatchObject({ id: "received", title: "Received", state: "complete" });
    }
  });
});
