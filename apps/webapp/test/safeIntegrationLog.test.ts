import { describe, expect, it } from "vitest";
import { slackSecretLogFields } from "../app/models/safeIntegrationLog.js";

const secret = {
  botAccessToken: "xoxb-BOT-SECRET",
  userAccessToken: "xoxp-USER-SECRET",
  refreshToken: "xoxe-REFRESH-SECRET",
  botScopes: ["chat:write", "channels:read"],
  userScopes: ["identity.basic"],
};

// Built right before secretStore encrypts the same object — the log fields must
// never carry the actual token strings.
describe("slackSecretLogFields", () => {
  it("emits presence booleans + scopes, never the token values", () => {
    const fields = slackSecretLogFields("int_123", secret);
    const serialized = JSON.stringify(fields);
    for (const token of ["xoxb-BOT-SECRET", "xoxp-USER-SECRET", "xoxe-REFRESH-SECRET"]) {
      expect(serialized).not.toContain(token);
    }
    expect(fields).toEqual({
      friendlyId: "int_123",
      hasUserToken: true,
      hasRefreshToken: true,
      botScopes: ["chat:write", "channels:read"],
      userScopes: ["identity.basic"],
    });
  });

  it("reports false when optional tokens are absent", () => {
    const fields = slackSecretLogFields("int_456", { botAccessToken: "xoxb-x", botScopes: [] });
    expect(fields.hasUserToken).toBe(false);
    expect(fields.hasRefreshToken).toBe(false);
  });
});
