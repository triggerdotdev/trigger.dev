import { expect, it, describe } from "vitest";
import { slotOf, expectOneSlot } from "./clusterSlot";

describe("slotOf", () => {
  it("matches the published CRC16/XMODEM check value and known slots", () => {
    expect(slotOf("123456789")).toBe(0x31c3);
    expect(slotOf("engine:snap:{run_1}:e")).toBe(8108);
    expect(slotOf("engine:snap:{run_2}:e")).toBe(12239);
  });

  it("hashes the whole key when the tag is empty or malformed", () => {
    expect(slotOf("snap:{}:e")).toBe(slotOf("snap:{}:e"));
    expect(slotOf("plain-key")).toBe(slotOf("plain-key"));
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
