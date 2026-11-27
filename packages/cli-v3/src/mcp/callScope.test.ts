import { describe, expect, it } from "vitest";
import { recordResolvedProjectRef, runInCallScope } from "./callScope.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("call scope", () => {
  // Catches: a shared "last ref" letting an overlapping call take another call's project.
  it("keeps the resolved ref per overlapping call", async () => {
    const a: { projectRef?: string } = {};
    const b: { projectRef?: string } = {};

    await Promise.all([
      runInCallScope(a, async () => {
        await tick();
        recordResolvedProjectRef("proj_a");
        await tick();
      }),
      runInCallScope(b, async () => {
        recordResolvedProjectRef("proj_b");
        await tick();
        await tick();
      }),
    ]);

    expect([a.projectRef, b.projectRef]).toEqual(["proj_a", "proj_b"]);
  });
});
