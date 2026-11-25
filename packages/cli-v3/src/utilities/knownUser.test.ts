import { afterEach, describe, expect, it } from "vitest";
import { forgetKnownUser, getKnownUser, knownUserGeneration, rememberUserId } from "./knownUser.js";

afterEach(() => forgetKnownUser());

describe("rememberUserId", () => {
  // Catches: an account lookup from before a profile switch becoming the known user again.
  it("ignores a lookup that began before forgetKnownUser", () => {
    const began = knownUserGeneration();
    forgetKnownUser();
    rememberUserId("old_user", "https://api.trigger.dev", began);
    expect(getKnownUser()).toBeUndefined();
  });
});
