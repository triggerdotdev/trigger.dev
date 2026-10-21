import { describe, expect, it, vi } from "vitest";
import { resolveReactionChoice } from "./ai.js";

describe("resolveReactionChoice", () => {
  it("returns a single string as-is", async () => {
    expect(await resolveReactionChoice("eyes", {})).toBe("eyes");
  });

  it("skips when absent or empty", async () => {
    expect(await resolveReactionChoice(undefined, {})).toBeUndefined();
    expect(await resolveReactionChoice("", {})).toBeUndefined();
    expect(await resolveReactionChoice([], {})).toBeUndefined();
    expect(await resolveReactionChoice(() => undefined, {})).toBeUndefined();
    expect(await resolveReactionChoice(() => null, {})).toBeUndefined();
  });

  it("picks a member of an array by a uniform random draw", async () => {
    const options = ["eyes", "hourglass", "thinking_face"];
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValueOnce(0);
      expect(await resolveReactionChoice(options, {})).toBe("eyes");
      random.mockReturnValueOnce(0.5);
      expect(await resolveReactionChoice(options, {})).toBe("hourglass");
      random.mockReturnValueOnce(0.999);
      expect(await resolveReactionChoice(options, {})).toBe("thinking_face");
    } finally {
      random.mockRestore();
    }
  });

  it("resolves a function of the event, returning a string or an array", async () => {
    const byKind = (e: unknown) => `emoji-${(e as { kind: string }).kind}`;
    expect(await resolveReactionChoice(byKind, { kind: "bug" })).toBe("emoji-bug");
    const picked = await resolveReactionChoice(() => ["a", "b"], {});
    expect(["a", "b"]).toContain(picked);
  });

  it("awaits an async resolver", async () => {
    expect(await resolveReactionChoice(async () => "shipit", {})).toBe("shipit");
  });
});
