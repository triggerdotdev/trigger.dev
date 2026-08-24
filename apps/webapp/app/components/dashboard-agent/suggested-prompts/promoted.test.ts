import { describe, expect, it } from "vitest";
import { parsePromotedPrompt } from "./promoted";

const valid = JSON.stringify({
  id: "sp:promo-blackfriday",
  label: "Check the queue",
  prompt: "How is the black-friday queue holding up?",
});

describe("parsePromotedPrompt", () => {
  it("reads a chip out of the flag value and marks it promoted", () => {
    expect(parsePromotedPrompt(valid)).toEqual({
      id: "sp:promo-blackfriday",
      label: "Check the queue",
      prompt: "How is the black-friday queue holding up?",
      source: "promoted",
    });
  });

  it("forces the promoted source even when the value claims otherwise", () => {
    const value = JSON.stringify({ id: "a", label: "b", prompt: "c", source: "default" });
    expect(parsePromotedPrompt(value)?.source).toBe("promoted");
  });

  it("ignores anything malformed", () => {
    for (const value of [
      undefined,
      null,
      "",
      "   ",
      "not json",
      "{}",
      JSON.stringify({ id: "a", label: "b" }),
      JSON.stringify({ id: "", label: "b", prompt: "c" }),
      JSON.stringify([{ id: "a", label: "b", prompt: "c" }]),
      JSON.stringify("a string"),
      42,
    ]) {
      expect(parsePromotedPrompt(value), String(value)).toBeUndefined();
    }
  });
});
