import { describe, expect, it } from "vitest";
import { MAX_URIS_PER_RESOLVE_REQUEST, planUriBatches } from "./resolve-uris";

const uri = (index: number) => `trigger://runs/run_${index}`;

describe("planUriBatches", () => {
  it("resolves a card's twenty citations in one request", () => {
    const batches = planUriBatches(Array.from({ length: 20 }, (_, index) => uri(index)));

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(20);
  });

  it("asks about each URI once", () => {
    const batches = planUriBatches([uri(1), uri(1), uri(2)]);

    expect(batches).toEqual([[uri(1), uri(2)]]);
  });

  it("caps a request and carries the rest over", () => {
    const count = MAX_URIS_PER_RESOLVE_REQUEST + 3;
    const batches = planUriBatches(Array.from({ length: count }, (_, index) => uri(index)));

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(MAX_URIS_PER_RESOLVE_REQUEST);
    expect(batches[1]).toHaveLength(3);
  });

  it("has nothing to send for nothing", () => {
    expect(planUriBatches([])).toEqual([]);
  });
});
