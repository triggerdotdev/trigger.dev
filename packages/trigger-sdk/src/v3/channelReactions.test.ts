import { describe, expect, it } from "vitest";
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

  it("picks a member of an array (randomly)", async () => {
    const options = ["eyes", "hourglass", "thinking_face"];
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const picked = await resolveReactionChoice(options, {});
      expect(options).toContain(picked);
      seen.add(picked!);
    }
    // Over 60 draws from 3 options, seeing only one is astronomically unlikely: proves it varies.
    expect(seen.size).toBeGreaterThan(1);
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
