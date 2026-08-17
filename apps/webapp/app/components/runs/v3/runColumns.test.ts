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

describe("resolveColumnLayout", () => {
  it("returns the default layout when cols is absent", () => {
    const layout = resolveColumnLayout({ cols: [], sc: [] }, cloud);
    expect(layout.isCustomized).toBe(false);
    expect(layout.hiddenStandard).toHaveLength(0);
    expect(layout.visible[0]).toMatchObject({ kind: "standard", def: { id: "id" } });
    expect(layout.visible).toHaveLength(availableStandardColumns(cloud).length);
  });

  it("keeps locked columns in the requested order (they are reorderable)", () => {
    const layout = resolveColumnLayout({ cols: ["task", "status", "id"], sc: [] }, cloud);
    const ids = layout.visible.map((c) => (c.kind === "standard" ? c.def.id : "smart"));
    expect(ids).toEqual(["task", "status", "id"]);
  });

  it("moves omitted standard columns into hiddenStandard", () => {
    const layout = resolveColumnLayout({ cols: ["id", "task", "status"], sc: [] }, cloud);
    const hidden = layout.hiddenStandard.map((c) => c.id);
    expect(hidden).toContain("tags");
    expect(hidden).toContain("ttl");
    expect(hidden).not.toContain("id");
  });

  it("never hides locked columns and reinserts them if the URL omits them", () => {
    const layout = resolveColumnLayout({ cols: ["id", "ver"], sc: [] }, cloud);
    const ids = layout.visible.filter((c) => c.kind === "standard").map((c) => c.def.id);
    expect(ids).toContain("task");
    expect(ids).toContain("status");
    const hidden = layout.hiddenStandard.map((c) => c.id);
    expect(hidden).not.toContain("task");
    expect(hidden).not.toContain("status");
  });

  it("resolves smart-column refs positionally", () => {
    const sc = [
      encodeSmartColumn({ source: "metadata", path: "$.failed", label: "Failed", displayAs: "number" }),
    ];
    const layout = resolveColumnLayout({ cols: ["id", "sc1"], sc }, cloud);
    const smart = layout.visible.find((c) => c.kind === "smart");
    expect(smart).toMatchObject({ kind: "smart", def: { label: "Failed", source: "metadata" } });
  });

  it("drops gated columns referenced on a runtime that lacks them", () => {
    const layout = resolveColumnLayout({ cols: ["id", "region", "compute", "task"], sc: [] }, dev);
    const ids = layout.visible.map((c) => (c.kind === "standard" ? c.def.id : "smart"));
    expect(ids).toEqual(["id", "task", "status"]);
  });
});

describe("encodeColumnLayout round-trip", () => {
  it("encodes the default layout to empty params", () => {
    const layout = resolveColumnLayout({ cols: [], sc: [] }, cloud);
    expect(encodeColumnLayout(layout.visible, cloud)).toEqual({ cols: [], sc: [] });
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
        { kind: "standard", def: availableStandardColumns(cloud).find((c) => c.id === "id")! },
        { kind: "standard", def: availableStandardColumns(cloud).find((c) => c.id === "status")! },
        { kind: "smart", index: 0, def: scDef },
      ],
      cloud
    );
    expect(encoded.cols).toEqual(["id", "status", "sc1"]);
    expect(encoded.sc).toHaveLength(1);

    const layout = resolveColumnLayout(encoded, cloud);
    const ids = layout.visible.map((c) => (c.kind === "standard" ? c.def.id : c.def.label));
    expect(ids).toEqual(["id", "task", "status", "Order total"]);
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
