import { describe, expect, it } from "vitest";
import type { SessionTraceRun } from "~/components/sessions/v1/trace/sessionTraceTypes";
import { adjacentRunNodeId } from "~/components/sessions/v1/trace/sessionTraceSelection";

const run = (n: number) => ({
  id: `run:run_${n}`,
  data: { kind: "run" as const, run: { friendlyId: `run_${n}`, number: n } as SessionTraceRun },
});
const span = (n: number) => ({
  id: `span:run_${n}:s`,
  data: { kind: "span" as const, runFriendlyId: `run_${n}`, spanId: "s", span: {} },
});
const rows = [
  { id: "session", data: { kind: "session" as const } },
  run(1),
  span(1),
  run(2),
  run(3),
] as Parameters<typeof adjacentRunNodeId>[0];
const all = () => true;

describe("adjacentRunNodeId", () => {
  // Catches: k from a span moving to the next row instead of the next run.
  it("moves from a span's run to the next or previous run", () => {
    expect(adjacentRunNodeId(rows, all, "span:run_1:s", "next")).toBe("run:run_2");
    expect(adjacentRunNodeId(rows, all, "run:run_2", "previous")).toBe("run:run_1");
  });

  // Catches: j/k landing on a run the search hid, which selects nothing visible.
  it("skips runs a search hides", () => {
    expect(adjacentRunNodeId(rows, (id) => id !== "run:run_2", "run:run_1", "next")).toBe(
      "run:run_3"
    );
  });

  it("stops at the ends and starts at the newest run from the session row", () => {
    expect(adjacentRunNodeId(rows, all, "run:run_3", "next")).toBeUndefined();
    expect(adjacentRunNodeId(rows, all, "run:run_1", "previous")).toBeUndefined();
    expect(adjacentRunNodeId(rows, all, "session", "previous")).toBe("run:run_3");
  });
});
