import { describe, it, expect } from "vitest";
import { BaselineCk, SfqCk, DrrCk, StrideCk, CodelCk } from "../disciplines.js";
import type { ActiveCk } from "../ckReader.js";

function ck(concurrencyKey: string, headScore: number): ActiveCk {
  return { ckQueue: `q:${concurrencyKey}`, concurrencyKey, headScore };
}

describe("CK disciplines", () => {
  it("baseline orders by head age (oldest first) and does not rescore", () => {
    const b = new BaselineCk();
    expect(b.rescore).toBe(false);
    const order = b.order([ck("a", 30), ck("b", 10), ck("c", 20)], 100);
    expect(order).toEqual(["q:b", "q:c", "q:a"]);
  });

  it("SFQ puts an under-served key ahead of an over-served one", () => {
    const s = new SfqCk();
    for (let i = 0; i < 10; i++) s.onServiced("a");
    const order = s.order([ck("a", 5), ck("b", 5)], 100);
    expect(order[0]).toBe("q:b");
  });

  it("DRR alternates evenly between two keys", () => {
    const d = new DrrCk();
    const active = [ck("a", 5), ck("b", 5)];
    let a = 0;
    let b = 0;
    for (let i = 0; i < 10; i++) {
      const top = d.order(active, 100)[0];
      if (top === "q:a") {
        a++;
        d.onServiced("a");
      } else {
        b++;
        d.onServiced("b");
      }
    }
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });

  it("stride serves an under-served key first", () => {
    const s = new StrideCk();
    for (let i = 0; i < 5; i++) s.onServiced("a");
    expect(s.order([ck("a", 5), ck("b", 5)], 100)[0]).toBe("q:b");
  });

  it("SFQ monotonic floor: a returning idle key does not monopolise", () => {
    const s = new SfqCk();
    // advance both, then 'b' idles while 'a' keeps getting served
    s.order([ck("a", 1), ck("b", 1)], 10);
    for (let i = 0; i < 20; i++) {
      s.order([ck("a", 1)], 10 + i);
      s.onServiced("a");
    }
    // b returns with its stale (low) clock; floor should have advanced, so b is
    // pulled up rather than sitting far below and monopolising
    const order = s.order([ck("a", 1), ck("b", 1)], 40);
    // b is served next (it is behind), but its clock jumps to the floor, so after
    // one serve a is competitive again rather than b taking 20 in a row
    expect(order[0]).toBe("q:b");
    s.onServiced("b");
    const after = s.order([ck("a", 1), ck("b", 1)], 41);
    expect(after[0]).toBe("q:a");
  });

  it("CoDel hoists a stale key then reverts", () => {
    // stub base always prefers a over b, so hoisting b is observable
    const stub = {
      name: "stub",
      rescore: true as const,
      order: (active: ActiveCk[]) =>
        [...active].sort((x, y) => (x.concurrencyKey < y.concurrencyKey ? -1 : 1)).map((a) => a.ckQueue),
      onServiced: () => {},
      reset: () => {},
    };
    const codel = new CodelCk(stub, 50, 100);
    // b's head is old (sojourn large); a is fresh
    codel.order([ck("a", 390), ck("b", 0)], 200); // start tracking b's overage
    const hoisted = codel.order([ck("a", 390), ck("b", 0)], 400); // interval elapsed
    expect(hoisted[0]).toBe("q:b");
    const reverted = codel.order([ck("a", 390), ck("b", 399)], 400); // b now fresh
    expect(reverted[0]).toBe("q:a");
  });
});
