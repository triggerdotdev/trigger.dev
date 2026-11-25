import { afterEach, describe, expect, it } from "vitest";
import { forgetKnownUser, getKnownUser } from "./knownUser.js";
import { isLoggedIn } from "./session.js";

afterEach(() => forgetKnownUser());

describe("isLoggedIn", () => {
  // Catches: a working stored login leaving analytics without the account and its server.
  it("remembers the user together with the server that answered", async () => {
    const result = await isLoggedIn("prod", {
      readProfile: () => ({ accessToken: "tr_pat_x", apiUrl: "https://api.trigger.dev" }),
      whoAmI: async () =>
        ({
          success: true,
          data: { userId: "user_1", email: "a@b.c", dashboardUrl: "https://cloud.trigger.dev" },
        }) as never,
    });

    expect(result.ok).toBe(true);
    expect(getKnownUser()).toEqual({ userId: "user_1", apiUrl: "https://api.trigger.dev" });
  });
});
