import { expect, it, describe } from "vitest";
import { slotOf, expectOneSlot } from "./clusterSlot";

describe("slotOf", () => {
  it("matches the published CRC16/XMODEM check value and known slots", () => {
    expect(slotOf("123456789")).toBe(0x31c3);
    expect(slotOf("engine:snap:{run_1}:e")).toBe(8108);
    expect(slotOf("engine:snap:{run_2}:e")).toBe(12239);
  });

  it("groups keys that share a non-empty tag into one slot", () => {
    expect(slotOf("a{tag}b")).toBe(slotOf("c{tag}d"));
  });

  it("hashes the whole key when the tag is empty (not the empty tag)", () => {
    // If the empty `{}` were used as the tag, these would collide; hashing the whole key keeps them apart.
    expect(slotOf("a{}b")).not.toBe(slotOf("c{}d"));
  });

  it("hashes the whole key when a brace is unclosed (malformed tag)", () => {
    // `b` is not a tag here (no closing brace), so these must not share a slot the way `{b}` would.
    expect(slotOf("a{b")).not.toBe(slotOf("x{b"));
  });

  it("hashes UTF-8 bytes, matching Redis for a non-ASCII tag", () => {
    // Redis (cluster-key-slot) hashes the UTF-8 bytes of `é` to slot 10180.
    expect(slotOf("{é}")).toBe(10180);
  });
});

describe("expectOneSlot", () => {
  it("passes when every key shares one slot", () => {
    expect(() => expectOneSlot(["snap:{r}:e", "snap:{r}:idx", "snap:{r}:cur"])).not.toThrow();
  });
  it("passes for zero or one key", () => {
    expect(() => expectOneSlot([])).not.toThrow();
    expect(() => expectOneSlot(["snap:{r}:e"])).not.toThrow();
  });
  it("throws when two keys fall in different slots", () => {
    expect(() => expectOneSlot(["snap:{run_1}:e", "snap:{run_2}:e"])).toThrow(/slot/i);
  });
});
