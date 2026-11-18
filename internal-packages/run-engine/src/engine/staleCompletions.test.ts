import { describe, expect, it } from "vitest";
import { refusalExplainsStall, type StaleCompletionNote } from "./staleCompletions.js";

const timeoutMs = 300_000;
const now = 1_000_000_000;
// The stall job runs one timeout after the last heartbeat, so this is when that heartbeat was.
const lastPossibleHeartbeat = now - timeoutMs;

const note = (overrides: Partial<StaleCompletionNote> = {}): StaleCompletionNote => ({
  postedSnapshotId: "snapshot_posted",
  latestSnapshotId: "snapshot_latest",
  attemptNumber: 1,
  ok: true,
  at: lastPossibleHeartbeat,
  ...overrides,
});

const snapshot = (createdAt: number, attemptNumber = 1, id = "snapshot_latest") => ({
  id,
  attemptNumber,
  createdAt: new Date(createdAt),
});

describe("refusalExplainsStall", () => {
  // Catches: the clear error not being used for the case it exists for.
  it("explains a stall when nothing heartbeated after the refusal", () => {
    const stalled = snapshot(lastPossibleHeartbeat - 2_000);
    expect(refusalExplainsStall({ note: note(), snapshot: stalled, timeoutMs, now })).toBe(true);
  });

  // Catches: a restored copy that carried on and died before its first heartbeat being told its
  // task returned, because the process it was copied from had a completion refused earlier.
  it("does not explain a stall of a snapshot made after the refusal", () => {
    const refused = note({ at: lastPossibleHeartbeat - 15_000 });
    const stalled = snapshot(lastPossibleHeartbeat, 1, "snapshot_after_restore");
    expect(refusalExplainsStall({ note: refused, snapshot: stalled, timeoutMs, now })).toBe(false);
  });

  // Catches: a copy of the process that carried on, and stalled later, being told its task returned.
  it("does not explain a stall when a heartbeat came after the refusal", () => {
    const refused = note({ at: lastPossibleHeartbeat - 60_000 });
    const stalled = snapshot(lastPossibleHeartbeat - 90_000);
    expect(refusalExplainsStall({ note: refused, snapshot: stalled, timeoutMs, now })).toBe(false);
  });

  it("does not explain a stall of another attempt", () => {
    const stalled = snapshot(lastPossibleHeartbeat - 2_000, 2);
    expect(refusalExplainsStall({ note: note(), snapshot: stalled, timeoutMs, now })).toBe(false);
  });

  // Catches: a task that threw being told it returned.
  it("does not explain a stall after a refused failure", () => {
    const stalled = snapshot(lastPossibleHeartbeat - 2_000);
    expect(
      refusalExplainsStall({ note: note({ ok: false }), snapshot: stalled, timeoutMs, now })
    ).toBe(false);
  });
});
