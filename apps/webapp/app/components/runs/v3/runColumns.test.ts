import { describe, expect, it } from "vitest";
import {
  availableStandardColumns,
  decodeSmartColumn,
  deriveRunSelect,
  encodeColumnLayout,
  encodeSmartColumn,
  resolveColumnLayout,
  type RunColumnRuntime,
  type SmartColumnDef,
} from "./runColumns";

const cloud: RunColumnRuntime = { isManagedCloud: true, isDevelopment: false };
const dev: RunColumnRuntime = { isManagedCloud: false, isDevelopment: true };

describe("deriveRunSelect", () => {
  it("always includes the presenter's scalar contract", () => {
    const select = deriveRunSelect([], []);
    for (const field of [
      "id",
      "friendlyId",
      "spanId",
      "status",
      "runtimeEnvironmentId",
      "rootTaskRunId",
      "createdAt",
      "updatedAt",
      "startedAt",
      "lockedAt",
      "completedAt",
      "queueTimestamp",
      "delayUntil",
      "scheduleId",
      "metadata",
      "metadataType",
      "taskIdentifier",
      "machinePreset",
      "queue",
      "runTags",
    ]) {
      expect(select[field as keyof typeof select]).toBe(true);
    }
  });

  it("does not hydrate the large blobs unless a smart column references them", () => {
    const select = deriveRunSelect(["task", "status", "tags"], []);
    expect(select.payload).toBeUndefined();
    expect(select.payloadType).toBeUndefined();
    expect(select.output).toBeUndefined();
    expect(select.outputType).toBeUndefined();
  });

  it("adds payload/output fields only for referenced smart sources", () => {
    const payloadOnly = deriveRunSelect([], ["payload"]);
    expect(payloadOnly.payload).toBe(true);
    expect(payloadOnly.payloadType).toBe(true);
    expect(payloadOnly.output).toBeUndefined();

    const both = deriveRunSelect([], ["payload", "output"]);
    expect(both.output).toBe(true);
    expect(both.outputType).toBe(true);
  });

  it("references metadata from the always-selected set without a smart source", () => {
    const select = deriveRunSelect([], ["metadata"]);
    expect(select.metadata).toBe(true);
    expect(select.metadataType).toBe(true);
  });
});

describe("availableStandardColumns gating", () => {
  it("includes compute and region on managed cloud", () => {
    const ids = availableStandardColumns(cloud).map((c) => c.id);
    expect(ids).toContain("compute");
    expect(ids).toContain("region");
  });

  it("drops compute and region on development / self-host", () => {
    const ids = availableStandardColumns(dev).map((c) => c.id);
    expect(ids).not.toContain("compute");
    expect(ids).not.toContain("region");
  });
});

const orderedIds = (layout: { ordered: { col: ResolvedColumn }[] }) =>
  layout.ordered.map((o) => (o.col.kind === "standard" ? o.col.def.id : o.col.def.label));

const visibleIds = (layout: { visible: ResolvedColumn[] }) =>
  layout.visible.map((c) => (c.kind === "standard" ? c.def.id : c.def.label));

describe("resolveColumnLayout", () => {
  it("returns the default layout when cols is absent", () => {
    const layout = resolveColumnLayout({ cols: [], sc: [] }, cloud);
    expect(layout.isCustomized).toBe(false);
    expect(layout.ordered.every((o) => !o.hidden)).toBe(true);
    expect(layout.ordered[0].col).toMatchObject({ kind: "standard", def: { id: "id" } });
    expect(layout.visible).toHaveLength(availableStandardColumns(cloud).length);
  });

  it("keeps every column in the requested order (columns are reorderable)", () => {
    const layout = resolveColumnLayout({ cols: ["task", "status", "id"], sc: [] }, cloud);
    expect(orderedIds(layout).slice(0, 3)).toEqual(["task", "status", "id"]);
  });

  it("hides a `-`-prefixed column in place without dropping it from the order", () => {
    const layout = resolveColumnLayout(
      { cols: ["id", "task", "status", "ver", "-ttl", "tags"], sc: [] },
      cloud
    );
    const ttl = layout.ordered.find((o) => o.col.kind === "standard" && o.col.def.id === "ttl");
    expect(ttl?.hidden).toBe(true);
    const ids = orderedIds(layout);
    expect(ids.indexOf("ttl")).toBeGreaterThan(ids.indexOf("ver"));
    expect(ids.indexOf("ttl")).toBeLessThan(ids.indexOf("tags"));
    expect(visibleIds(layout)).not.toContain("ttl");
  });

  it("never hides locked columns, even with a `-` prefix", () => {
    const layout = resolveColumnLayout({ cols: ["id", "-task", "-status", "ver"], sc: [] }, cloud);
    const locked = layout.ordered.filter(
      (o) => o.col.kind === "standard" && o.col.def.locked
    );
    expect(locked.every((o) => !o.hidden)).toBe(true);
  });

  it("reinserts standard columns missing from the URL as visible", () => {
    const layout = resolveColumnLayout({ cols: ["id", "ver"], sc: [] }, cloud);
    expect(visibleIds(layout)).toEqual(expect.arrayContaining(["task", "status", "tags", "ttl"]));
  });

  it("resolves smart-column refs positionally", () => {
    const sc = [
      encodeSmartColumn({
        source: "metadata",
        path: "$.failed",
        label: "Failed",
        displayAs: "number",
      }),
    ];
    const layout = resolveColumnLayout({ cols: ["id", "sc1"], sc }, cloud);
    const smart = layout.visible.find((c) => c.kind === "smart");
    expect(smart).toMatchObject({ kind: "smart", def: { label: "Failed", source: "metadata" } });
  });

  it("drops gated columns referenced on a runtime that lacks them", () => {
    const layout = resolveColumnLayout({ cols: ["id", "region", "compute", "task"], sc: [] }, dev);
    expect(orderedIds(layout)).not.toContain("region");
    expect(orderedIds(layout)).not.toContain("compute");
    expect(orderedIds(layout).slice(0, 2)).toEqual(["id", "task"]);
  });
});

describe("encodeColumnLayout round-trip", () => {
  const std = (id: string) => ({
    kind: "standard" as const,
    def: availableStandardColumns(cloud).find((c) => c.id === id)!,
  });

  it("encodes the default layout to empty params", () => {
    const layout = resolveColumnLayout({ cols: [], sc: [] }, cloud);
    expect(encodeColumnLayout(layout.ordered, cloud)).toEqual({ cols: [], sc: [] });
  });

  it("round-trips a reordered, hidden, smart-augmented layout", () => {
    const scDef: SmartColumnDef = {
      source: "payload",
      path: "$.order.total",
      label: "Order total",
      displayAs: "number",
    };
    const encoded = encodeColumnLayout(
      [
        { col: std("id"), hidden: false },
        { col: std("status"), hidden: false },
        { col: std("ttl"), hidden: true },
        { col: { kind: "smart", index: 0, def: scDef }, hidden: false },
      ],
      cloud
    );
    expect(encoded.cols).toEqual(["id", "status", "-ttl", "sc1"]);
    expect(encoded.sc).toHaveLength(1);

    const layout = resolveColumnLayout(encoded, cloud);
    const ttl = layout.ordered.find((o) => o.col.kind === "standard" && o.col.def.id === "ttl");
    expect(ttl?.hidden).toBe(true);
    expect(visibleIds(layout)).toContain("Order total");
    expect(visibleIds(layout)).not.toContain("ttl");
  });
});

describe("smart column codec", () => {
  it("round-trips including delimiter-dangerous characters", () => {
    const def: SmartColumnDef = {
      source: "metadata",
      path: "$['a:b'].c",
      label: "Weird: 50%",
      displayAs: "badge",
    };
    const decoded = decodeSmartColumn(encodeSmartColumn(def));
    expect(decoded).toEqual(def);
  });

  it("rejects an unknown source or display", () => {
    expect(decodeSmartColumn("bogus:$.a:A:number")).toBeUndefined();
    expect(decodeSmartColumn("metadata:$.a:A:bogus")).toBeUndefined();
    expect(decodeSmartColumn("metadata::A:number")).toBeUndefined();
  });
});
