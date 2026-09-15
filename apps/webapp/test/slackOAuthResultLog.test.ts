import { describe, expect, it } from "vitest";
import { slackAccessResultLogFields } from "../app/models/slackOAuthResultLog.js";

const result = {
  ok: true,
  access_token: "xoxb-BOT-SECRET",
  refresh_token: "xoxe-REFRESH-SECRET",
  scope: "chat:write,channels:read",
  team: { id: "T123" },
  authed_user: { id: "U1", access_token: "xoxp-USER-SECRET" },
};

// Logged right after the Slack OAuth exchange — must never carry the tokens.
describe("slackAccessResultLogFields", () => {
  it("emits only non-secret diagnostics, never the tokens", () => {
    const fields = slackAccessResultLogFields(result);
    const serialized = JSON.stringify(fields);
    for (const token of ["xoxb-BOT-SECRET", "xoxp-USER-SECRET", "xoxe-REFRESH-SECRET"]) {
      expect(serialized).not.toContain(token);
    }
    expect(fields).toEqual({
      teamId: "T123",
      scope: "chat:write,channels:read",
      hasUserToken: true,
      hasRefreshToken: true,
    });
  });

  it("reports false when user/refresh tokens are absent", () => {
    const fields = slackAccessResultLogFields({ team: { id: "T9" }, scope: "chat:write" });
    expect(fields.hasUserToken).toBe(false);
    expect(fields.hasRefreshToken).toBe(false);
  });
});
