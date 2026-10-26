import { describe, expect, it } from "vitest";
import {
  buildStateBuckets,
  compareAlertRows,
  episodeSummary,
  type AlertListRow,
} from "./alertListRow";

function row(overrides: Partial<AlertListRow>): AlertListRow {
  return {
    id: "alert_1",
    name: "Alert",
    area: "queues",
    conditionSummary: "> 100 over 5m",
    capabilityKey: "queue.depth",
    capabilityTitle: "Queue depth",
    environmentId: "env_1",
    scope: { type: "all" },
    status: "active",
    lastEventAt: null,
    notifierCount: 0,
    expiresAt: null,
    lastActivityAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("compareAlertRows", () => {
  it("puts needs_attention first, then active, then inactive", () => {
    const inactive = row({ id: "a", name: "A", status: "inactive" });
    const active = row({ id: "b", name: "B", status: "active" });
    const raised = row({ id: "c", name: "C", status: "needs_attention" });

    const sorted = [inactive, active, raised].sort(compareAlertRows);

    expect(sorted.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("sorts newest-first within a status group (mutation: alphabetical would put Alpha first)", () => {
    const older = row({
      id: "a",
      name: "Alpha",
      status: "active",
      lastActivityAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = row({
      id: "b",
      name: "Bravo",
      status: "active",
      lastActivityAt: new Date("2026-01-02T00:00:00Z"),
    });

    expect([older, newer].sort(compareAlertRows).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("sorts correctly when lastActivityAt is an ISO string (serialized via defer)", () => {
    const older = row({
      id: "a",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = row({
      id: "b",
      status: "active",
      lastActivityAt: "2026-01-02T00:00:00.000Z",
    });

    expect([older, newer].sort(compareAlertRows).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("stable tie-breaker by id when lastActivityAt is equal", () => {
    const ts = new Date("2026-01-01T00:00:00Z");
    const x = row({ id: "alert_x", status: "active", lastActivityAt: ts });
    const y = row({ id: "alert_y", status: "active", lastActivityAt: ts });

    expect([y, x].sort(compareAlertRows).map((r) => r.id)).toEqual(["alert_x", "alert_y"]);
    expect([x, y].sort(compareAlertRows).map((r) => r.id)).toEqual(["alert_x", "alert_y"]);
  });
});

describe("episodeSummary", () => {
  const raisedAt = new Date("2026-01-01T00:00:00Z");
  const recoveredAt = new Date("2026-01-01T12:00:00Z");
  const resolvedAt = new Date("2026-01-02T00:00:00Z");
  const stoppedAt = new Date("2026-01-03T00:00:00Z");
  const expiresAt = new Date("2026-01-04T00:00:00Z");

  it("reads a needs_attention row as the open raise", () => {
    expect(
      episodeSummary({
        status: "needs_attention",
        raisedAt,
        recoveredAt: null,
        resolvedAt: null,
        stoppedAt: null,
        expiresAt: null,
      })
    ).toEqual({ kind: "raised", at: raisedAt });
  });

  it("includes recoveredAt on a raised episode when available", () => {
    expect(
      episodeSummary({
        status: "needs_attention",
        raisedAt,
        recoveredAt,
        resolvedAt: null,
        stoppedAt: null,
        expiresAt: null,
      })
    ).toEqual({ kind: "raised", at: raisedAt, recoveredAt });
  });

  it("a raise newer than the last recovery stays raised, not recovered", () => {
    const newerRaise = new Date("2026-01-02T00:00:00Z");
    const result = episodeSummary({
      status: "needs_attention",
      raisedAt: newerRaise,
      recoveredAt,
      resolvedAt: null,
      stoppedAt: null,
      expiresAt: null,
    });
    expect(result).toEqual({ kind: "raised", at: newerRaise, recoveredAt: undefined });
  });

  it("a recovery is void while the condition is met again", () => {
    const result = episodeSummary({
      status: "needs_attention",
      raisedAt,
      recoveredAt,
      resolvedAt: null,
      stoppedAt: null,
      expiresAt: null,
      observedCondition: "met",
    });
    expect(result).toEqual({ kind: "raised", at: raisedAt, recoveredAt: undefined });
  });

  it("omits recoveredAt when null", () => {
    const result = episodeSummary({
      status: "needs_attention",
      raisedAt,
      recoveredAt: null,
      resolvedAt: null,
      stoppedAt: null,
      expiresAt: null,
    });
    expect(result).toEqual({ kind: "raised", at: raisedAt });
    expect(result && "recoveredAt" in result ? result.recoveredAt : undefined).toBeUndefined();
  });

  it("reads a completed-inactive row as resolved", () => {
    expect(
      episodeSummary({
        status: "inactive",
        inactiveReason: "completed",
        raisedAt: null,
        recoveredAt: null,
        resolvedAt,
        stoppedAt: null,
        expiresAt: null,
      })
    ).toEqual({ kind: "resolved", at: resolvedAt });
  });

  it("shows recovered_at between raised and resolved", () => {
    const result = episodeSummary({
      status: "inactive",
      inactiveReason: "completed",
      raisedAt,
      recoveredAt,
      resolvedAt,
      stoppedAt: null,
      expiresAt: null,
    });
    expect(result).toEqual({ kind: "resolved", at: resolvedAt, recoveredAt });
  });

  it("reads a stopped-inactive row as stopped", () => {
    expect(
      episodeSummary({
        status: "inactive",
        inactiveReason: "stopped",
        raisedAt: null,
        recoveredAt: null,
        resolvedAt: null,
        stoppedAt,
        expiresAt: null,
      })
    ).toEqual({ kind: "stopped", at: stoppedAt });
  });

  it("reads an expired-inactive row as expired", () => {
    expect(
      episodeSummary({
        status: "inactive",
        inactiveReason: "expired",
        raisedAt: null,
        recoveredAt: null,
        resolvedAt: null,
        stoppedAt: null,
        expiresAt,
      })
    ).toEqual({ kind: "expired", at: expiresAt });
  });

  it("has nothing to say about an active row that never raised", () => {
    expect(
      episodeSummary({
        status: "active",
        raisedAt: null,
        recoveredAt: null,
        resolvedAt: null,
        stoppedAt: null,
        expiresAt: null,
      })
    ).toBeUndefined();
  });
});

describe("buildStateBuckets", () => {
  const HOUR = 3600_000;
  it("marks a bucket raised when it raises and clears inside it", () => {
    const buckets = buildStateBuckets(
      [
        { type: "raised", at: new Date(2 * HOUR + 60_000) },
        { type: "recovered", at: new Date(2 * HOUR + 120_000) },
      ],
      0,
      2 * HOUR,
      3
    );
    expect(buckets.map((b) => b.raised)).toEqual([false, true, false]);
  });

  it("ignores legacy matched events", () => {
    const buckets = buildStateBuckets(
      [{ type: "matched", at: new Date(2 * HOUR + 60_000) }],
      0,
      2 * HOUR,
      3
    );
    expect(buckets.map((b) => b.raised)).toEqual([false, false, false]);
  });
});
