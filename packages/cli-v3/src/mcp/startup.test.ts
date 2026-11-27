import { describe, expect, it } from "vitest";
import { adoptProjectProfile, handleInitialized } from "./startup.js";

describe("handleInitialized", () => {
  // Catches: the session starting before the project's profile is known.
  it("loads the project profile before the session starts, even when loading fails", async () => {
    const order: string[] = [];
    await handleInitialized({
      loadProjectProfile: async () => {
        order.push("profile");
        throw new Error("no cwd");
      },
      sessionStarted: () => order.push("session"),
    });
    expect(order).toEqual(["profile", "session"]);
  });
});

describe("adoptProjectProfile", () => {
  // Catches: a changed profile leaving the previous account attached to analytics.
  it("resets only when the profile changes", () => {
    const options = { profile: "default" };
    let resets = 0;
    const reset = () => resets++;

    expect(adoptProjectProfile(options, undefined, reset)).toBe(false);
    expect(adoptProjectProfile(options, "default", reset)).toBe(false);
    expect(adoptProjectProfile(options, "local", reset)).toBe(true);
    expect(options.profile).toBe("local");
    expect(resets).toBe(1);
  });
});
