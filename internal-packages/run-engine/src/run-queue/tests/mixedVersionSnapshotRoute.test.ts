import { describe, expect, it } from "vitest";
import { parseSnapshotRoute, toWireRoute } from "@internal/run-store";
import { InputPayload } from "../types.js";

// Mixed-version queue compatibility, both directions. During a rolling deploy a producer and a consumer
// can be on different versions, so the snapshotRoute field must survive that in both directions without
// breaking either side. Pure: the wire schema + the payload schema + the on-consume parser, no infra.

const base = {
  runId: "run_mixedver",
  orgId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  environmentType: "PRODUCTION" as const,
  queue: "task/q",
  timestamp: 1,
  attempt: 1,
};

// A representative LEGACY schema: the payload as it was BEFORE the snapshotRoute field existed.
const LegacyInputPayload = InputPayload.omit({ snapshotRoute: true });

describe("mixed-version snapshotRoute compatibility", () => {
  it("old payload (no snapshotRoute) is consumed by the new reader and resolves to no route", () => {
    // A producer on the old version writes a payload with no snapshotRoute key at all.
    const oldPayload = { ...base };
    const parsed = InputPayload.parse(oldPayload);
    expect(parsed.snapshotRoute).toBeUndefined();
    // The new consumer parses the (absent) route: undefined, so it falls back to the durable resolver.
    expect(parseSnapshotRoute(parsed.snapshotRoute)).toBeUndefined();
  });

  it("new payload (with snapshotRoute) is consumed by the new reader and yields the route", () => {
    const wire = toWireRoute({
      runId: base.runId,
      organizationId: base.orgId,
      residency: "redis-primary",
    });
    const newPayload = { ...base, snapshotRoute: wire };
    const parsed = InputPayload.parse(newPayload);
    const route = parseSnapshotRoute(parsed.snapshotRoute);
    expect(route).toEqual({ version: 1, residency: "redis-primary", organizationId: base.orgId });
  });

  it("new payload is accepted by a legacy schema, which strips the unknown snapshotRoute without error", () => {
    const wire = toWireRoute({
      runId: base.runId,
      organizationId: base.orgId,
      residency: "mirrored",
    });
    const newPayload = { ...base, snapshotRoute: wire };
    // The legacy consumer's schema has no snapshotRoute field; parsing must succeed and drop it.
    const legacy = LegacyInputPayload.parse(newPayload);
    expect((legacy as Record<string, unknown>).snapshotRoute).toBeUndefined();
    expect(legacy.runId).toBe(base.runId);
  });

  it("a future-version or malformed route never breaks the new reader (falls back, never throws)", () => {
    for (const bad of [
      { version: 2, residency: "redis-primary", organizationId: base.orgId }, // a version this build predates
      { version: 1, residency: "quantum", organizationId: base.orgId }, // unknown residency
      { version: 1, residency: "redis-primary" }, // missing org
      "not-an-object",
      42,
    ]) {
      const parsed = InputPayload.parse({ ...base, snapshotRoute: bad });
      expect(() => parseSnapshotRoute(parsed.snapshotRoute)).not.toThrow();
      expect(parseSnapshotRoute(parsed.snapshotRoute)).toBeUndefined();
    }
  });
});
