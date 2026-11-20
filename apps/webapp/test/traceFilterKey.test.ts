import { describe, expect, it } from "vitest";
import { traceFilterKey } from "~/components/runs/v3/trace/traceFilterKey";

const events = (errors: Record<string, boolean>) =>
  Object.entries(errors).map(([id, isError]) => ({ id, data: { isError } }));

describe("traceFilterKey", () => {
  it("changes when a span turns into an error or a message changes", () => {
    const before = traceFilterKey([{ events: events({ a: true, b: false }), messageChanges: 0 }]);

    expect(traceFilterKey([{ events: events({ a: true, b: true }), messageChanges: 0 }])).not.toBe(
      before
    );
    expect(traceFilterKey([{ events: events({ a: true, b: false }), messageChanges: 1 }])).not.toBe(
      before
    );
    expect(traceFilterKey([{ events: events({ a: true, b: false }), messageChanges: 0 }])).toBe(
      before
    );
  });

  // Catches: one span stopping being an error while another becomes one, same count.
  it("changes when the error spans change but their count doesn't", () => {
    const before = traceFilterKey([{ events: events({ a: true, b: false }), messageChanges: 0 }]);

    expect(traceFilterKey([{ events: events({ a: false, b: true }), messageChanges: 0 }])).not.toBe(
      before
    );
  });

  // Catches: one run's counter resetting while another's goes up, same total.
  it("keeps each run's changes apart", () => {
    const before = traceFilterKey([
      { events: [], messageChanges: 1 },
      { events: [], messageChanges: 0 },
    ]);

    expect(
      traceFilterKey([
        { events: [], messageChanges: 0 },
        { events: [], messageChanges: 1 },
      ])
    ).not.toBe(before);
  });
});
