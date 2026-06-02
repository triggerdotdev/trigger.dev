import { describe, it, expect } from "vitest";
import { encodeBaggage } from "./baggage.js";

describe("encodeBaggage", () => {
  it("returns empty string for an empty map", () => {
    expect(encodeBaggage({})).toBe("");
  });

  it("encodes a single entry as k=v", () => {
    expect(encodeBaggage({ run_id: "run-1" })).toBe("run_id=run-1");
  });

  it("sorts keys for stable output across hops", () => {
    expect(encodeBaggage({ b: "2", a: "1", c: "3" })).toBe("a=1,b=2,c=3");
  });

  it("skips empty keys and empty values", () => {
    expect(encodeBaggage({ "": "v", k: "", real: "x" })).toBe("real=x");
  });

  it("truncates values longer than the cap", () => {
    const long = "x".repeat(1024);
    const got = encodeBaggage({ k: long });
    const value = got.slice("k=".length);
    expect(value.length).toBe(256);
  });

  it("caps multibyte values by UTF-8 bytes, not code units", () => {
    const long = "あ".repeat(512); // 3 UTF-8 bytes each
    const got = encodeBaggage({ k: long });
    const value = got.slice("k=".length);
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(256);
  });

  it("caps the number of entries", () => {
    const meta: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      // Sortable two-digit keys so we know which 32 survive.
      meta[`k${String(i).padStart(2, "0")}`] = "v";
    }
    const got = encodeBaggage(meta);
    expect(got.split(",").length).toBe(32);
  });
});
