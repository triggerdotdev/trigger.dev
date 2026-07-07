import { describe, it, expect } from "vitest";
import {
  computeStoreForCompletion,
  selectStoreForWaitpoint,
} from "~/v3/runOpsMigration/crossSeamGuard.server";
// Real sample ids exercising the genuine run-id residency classifier (no stub).
const NEW = "waitpoint_" + "a".repeat(24) + "01"; // v1 body (version "1" at index 25) -> NEW
const LEGACY = "waitpoint_" + "a".repeat(25); // 25-char cuid body -> LEGACY
const UNRECOGNIZED = "waitpoint_" + "a".repeat(10); // no version marker -> LEGACY

describe("selectStoreForWaitpoint — happy-path residency routing", () => {
  it("MANUAL completion of a NEW waitpoint selects the new store", () => {
    const d = selectStoreForWaitpoint({ waitpointId: NEW, routeKind: "MANUAL" });
    expect(d.store).toBe("new");
    expect(d.residency).toBe("NEW");
  });

  it("RESUME_TOKEN completion of a LEGACY waitpoint selects the legacy store", () => {
    const d = selectStoreForWaitpoint({ waitpointId: LEGACY, routeKind: "RESUME_TOKEN" });
    expect(d.store).toBe("legacy");
    expect(d.residency).toBe("LEGACY");
  });

  it("DATETIME completion of a NEW waitpoint selects the new store", () => {
    expect(selectStoreForWaitpoint({ waitpointId: NEW, routeKind: "DATETIME" }).store).toBe("new");
  });

  it("RUN completion of a NEW waitpoint selects the new store", () => {
    expect(selectStoreForWaitpoint({ waitpointId: NEW, routeKind: "RUN" }).store).toBe("new");
  });

  it("IDEMPOTENCY_REUSE of a NEW waitpoint with no pins selects the new store", () => {
    const d = selectStoreForWaitpoint({ waitpointId: NEW, routeKind: "IDEMPOTENCY_REUSE" });
    expect(d.store).toBe("new");
    expect(d.pinnedReason).toBeUndefined();
  });
});

describe("selectStoreForWaitpoint — legacy pins", () => {
  it("pins a NEW-residency waitpoint to legacy when non-tree-owned", () => {
    const d = selectStoreForWaitpoint({
      waitpointId: NEW,
      routeKind: "MANUAL",
      treeOwnerResidency: "LEGACY",
    });
    expect(d.store).toBe("legacy");
    expect(d.pinnedReason).toBe("non-tree-owned");
  });

  it("pins cross-tree idempotency reuse to legacy", () => {
    const d = selectStoreForWaitpoint({
      waitpointId: NEW,
      routeKind: "IDEMPOTENCY_REUSE",
      isCrossTreeIdempotency: true,
    });
    expect(d.store).toBe("legacy");
    expect(d.pinnedReason).toBe("cross-tree-idempotency");
  });

  it("pins a descendant of a legacy parent to legacy", () => {
    const d = selectStoreForWaitpoint({
      waitpointId: NEW,
      routeKind: "RUN",
      hasLegacyParent: true,
    });
    expect(d.store).toBe("legacy");
    expect(d.pinnedReason).toBe("legacy-parent-descendant");
  });

  it("applies deterministic pin precedence: non-tree-owned wins", () => {
    const d = selectStoreForWaitpoint({
      waitpointId: NEW,
      routeKind: "RUN",
      treeOwnerResidency: "LEGACY",
      isCrossTreeIdempotency: true,
      hasLegacyParent: true,
    });
    expect(d.store).toBe("legacy");
    expect(d.pinnedReason).toBe("non-tree-owned");
  });

  it("reports the waitpoint's own residency even when pinned to legacy", () => {
    const d = selectStoreForWaitpoint({
      waitpointId: NEW,
      routeKind: "MANUAL",
      treeOwnerResidency: "LEGACY",
    });
    expect(d.store).toBe("legacy");
    expect(d.residency).toBe("NEW");
  });
});

describe("selectStoreForWaitpoint — unrecognized shapes and unknown routes", () => {
  it("routes an id without the v1 version marker to legacy (classification is total)", () => {
    const d = selectStoreForWaitpoint({ waitpointId: UNRECOGNIZED, routeKind: "MANUAL" });
    expect(d.store).toBe("legacy");
    expect(d.residency).toBe("LEGACY");
  });

  it("throws when an unknown routeKind is supplied", () => {
    expect(() =>
      // @ts-expect-error deliberately invalid kind
      selectStoreForWaitpoint({ waitpointId: NEW, routeKind: "WAT" as any })
    ).toThrow();
  });
});

describe("computeStoreForCompletion — single-DB no-op + flag wrapper", () => {
  it("returns the single store without classifying when split is OFF", () => {
    const calls: string[] = [];
    const d = computeStoreForCompletion(
      { waitpointId: UNRECOGNIZED, routeKind: "MANUAL" },
      {
        splitEnabled: false,
        classify: (id) => {
          calls.push(id);
          return "NEW";
        },
      }
    );
    expect(d.store).toBe("legacy"); // the single store
    expect(calls).toEqual([]); // classifier never consulted
  });

  it("delegates to selectStoreForWaitpoint when split is ON", () => {
    const d = computeStoreForCompletion(
      { waitpointId: NEW, routeKind: "MANUAL" },
      { splitEnabled: true }
    );
    expect(d.store).toBe("new");
  });
});
