import { describe, expect, it } from "vitest";
import { applyPoolKnobOverrides, type ResolvedPoolKnobs } from "~/v3/runOpsPoolKnobs.server";

// Literal defaults, so the assertions lock the override logic against fixed values rather than
// against the same env expression the implementation reads. No env import (webapp test rule).
const DEFAULTS: ResolvedPoolKnobs = {
  writerPoolTimeout: 10,
  writerConnectionTimeout: 20,
  writerDriverAdapter: false,
  connectionLimit: 30,
  replicaConnectionLimit: 40,
  replicaPoolTimeout: 50,
  replicaConnectionTimeout: 60,
  replicaDriverAdapter: false,
};

describe("applyPoolKnobOverrides", () => {
  it("returns the defaults verbatim when no descriptor knobs are given", () => {
    expect(applyPoolKnobOverrides(DEFAULTS)).toEqual(DEFAULTS);
    expect(applyPoolKnobOverrides(DEFAULTS, {})).toEqual(DEFAULTS);
  });

  it("overrides only the fields the descriptor sets", () => {
    const result = applyPoolKnobOverrides(DEFAULTS, {
      connectionLimit: 999,
      writerDriverAdapter: true,
      replicaPoolTimeout: 555,
    });
    expect(result.connectionLimit).toBe(999);
    expect(result.writerDriverAdapter).toBe(true);
    expect(result.replicaPoolTimeout).toBe(555);
    // Untouched fields keep the defaults.
    expect(result.writerPoolTimeout).toBe(10);
    expect(result.replicaConnectionLimit).toBe(40);
    expect(result.replicaDriverAdapter).toBe(false);
  });

  it("does not read the transaction knobs off the descriptor", () => {
    const result = applyPoolKnobOverrides(DEFAULTS, { transactionMaxWaitMs: 1234 });
    expect(result).toEqual(DEFAULTS);
  });
});
