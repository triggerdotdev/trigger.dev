// Pure unit tests for the residency + route types and the versioned wire-route parser. No infra.
import { describe, expect, it } from "vitest";
import {
  parseSnapshotRoute,
  snapshotRouteFromWire,
  toWireRoute,
  type SnapshotRoute,
} from "./snapshotResidency.js";

describe("parseSnapshotRoute (versioned, validated, never throws)", () => {
  it("accepts a valid v1 wire route", () => {
    const wire = { version: 1, residency: "redis-primary", organizationId: "org_a" };
    expect(parseSnapshotRoute(wire)).toEqual(wire);
  });

  it("accepts every known residency", () => {
    for (const residency of ["postgres", "mirrored", "redis-primary"] as const) {
      expect(parseSnapshotRoute({ version: 1, residency, organizationId: "org_a" })).toEqual({
        version: 1,
        residency,
        organizationId: "org_a",
      });
    }
  });

  it("returns undefined (does not throw) for an unknown version", () => {
    expect(
      parseSnapshotRoute({ version: 2, residency: "mirrored", organizationId: "org_a" })
    ).toBeUndefined();
  });

  it("returns undefined for an unknown residency value", () => {
    expect(
      parseSnapshotRoute({ version: 1, residency: "redis-read", organizationId: "org_a" })
    ).toBeUndefined();
  });

  it("returns undefined when organizationId is missing or empty", () => {
    expect(parseSnapshotRoute({ version: 1, residency: "mirrored" })).toBeUndefined();
    expect(
      parseSnapshotRoute({ version: 1, residency: "mirrored", organizationId: "" })
    ).toBeUndefined();
  });

  it("returns undefined for non-object / garbage input, never throwing", () => {
    for (const bad of [undefined, null, 42, "route", [], {}]) {
      expect(parseSnapshotRoute(bad)).toBeUndefined();
    }
  });

  it("carries NO runId on the wire (canonical v1 shape)", () => {
    const parsed = parseSnapshotRoute({
      version: 1,
      residency: "mirrored",
      organizationId: "org_a",
      runId: "run_x",
    });
    // extra keys are stripped; runId is never part of the wire route
    expect(parsed).toEqual({ version: 1, residency: "mirrored", organizationId: "org_a" });
    expect(parsed && "runId" in parsed).toBe(false);
  });
});

describe("toWireRoute / snapshotRouteFromWire round-trip", () => {
  const route: SnapshotRoute = {
    runId: "run_x",
    organizationId: "org_a",
    residency: "redis-primary",
  };

  it("toWireRoute drops runId and stamps version 1", () => {
    expect(toWireRoute(route)).toEqual({
      version: 1,
      residency: "redis-primary",
      organizationId: "org_a",
    });
  });

  it("snapshotRouteFromWire reconstructs the in-memory route from the wire + the message's trusted runId", () => {
    const wire = toWireRoute(route);
    expect(snapshotRouteFromWire(wire, "run_x")).toEqual(route);
  });
});
