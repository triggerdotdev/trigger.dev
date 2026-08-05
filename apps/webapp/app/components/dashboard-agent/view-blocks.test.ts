import { describe, expect, it } from "vitest";
import { blockIdentity, blockKey, latestRevisionBlocks } from "./view-blocks";

const enveloped = (id: string, revision: number, type = "diagnosis") => ({ type, id, revision });

describe("latestRevisionBlocks", () => {
  it("keeps every block when none carry an envelope", () => {
    const blocks = [{ type: "diagnosis" }, { type: "chart" }, { type: "diagnosis" }];
    expect(latestRevisionBlocks(blocks)).toEqual(blocks);
  });

  it("collapses revisions of the same (type, id) to the highest revision", () => {
    const blocks = [enveloped("d1", 1), enveloped("d1", 3), enveloped("d1", 2)];
    expect(latestRevisionBlocks(blocks)).toEqual([enveloped("d1", 3)]);
  });

  it("keeps the last block on a revision tie", () => {
    const first = { type: "diagnosis", id: "d1", revision: 2, summary: "old" };
    const second = { type: "diagnosis", id: "d1", revision: 2, summary: "new" };
    expect(latestRevisionBlocks([first, second])).toEqual([second]);
  });

  it("treats a missing revision as 0", () => {
    const blocks = [{ type: "diagnosis", id: "d1" }, enveloped("d1", 1)];
    expect(latestRevisionBlocks(blocks)).toEqual([enveloped("d1", 1)]);
  });

  it("does not group across types or ids", () => {
    const blocks = [enveloped("d1", 1), enveloped("d1", 1, "chart"), enveloped("d2", 1)];
    expect(latestRevisionBlocks(blocks)).toEqual(blocks);
  });

  it("keeps envelope-less blocks alongside collapsed ones, in order", () => {
    const legacy = { type: "chart" };
    const blocks = [enveloped("d1", 1), legacy, enveloped("d1", 2)];
    expect(latestRevisionBlocks(blocks)).toEqual([legacy, enveloped("d1", 2)]);
  });

  // The investigation block is the one progressive block: one revision per render,
  // and a chat that renders it three times still shows one card.
  it("collapses an investigation's revisions to the current one", () => {
    const revision = (n: number, outcome: string) => ({
      type: "investigation",
      id: "inv_abc123",
      revision: n,
      version: 1,
      investigation: { outcome },
    });
    const blocks = [
      revision(0, "in_progress"),
      revision(1, "in_progress"),
      revision(2, "concluded"),
    ];
    expect(latestRevisionBlocks(blocks)).toEqual([revision(2, "concluded")]);
  });

  it("keeps two different investigations apart", () => {
    const blocks = [enveloped("inv_1", 1, "investigation"), enveloped("inv_2", 0, "investigation")];
    expect(latestRevisionBlocks(blocks)).toEqual(blocks);
  });

  it("tolerates a non-array", () => {
    expect(latestRevisionBlocks(undefined as unknown as unknown[])).toEqual([]);
  });
});

describe("blockIdentity / blockKey", () => {
  it("identifies enveloped blocks by type and id", () => {
    expect(blockIdentity(enveloped("d1", 1))).toBe("diagnosis::d1");
  });

  it("has no identity without a usable id", () => {
    expect(blockIdentity({ type: "diagnosis" })).toBeUndefined();
    expect(blockIdentity({ type: "diagnosis", id: "" })).toBeUndefined();
    expect(blockIdentity({ id: "d1" })).toBeUndefined();
    expect(blockIdentity(null)).toBeUndefined();
  });

  it("falls back to the index as the key", () => {
    expect(blockKey({ type: "diagnosis" }, 2)).toBe("index:2");
    expect(blockKey(enveloped("d1", 1), 2)).toBe("diagnosis::d1");
  });
});
