import { describe, expect, it } from "vitest";
import { WebhookGetHandshakeConfig } from "./webhookConfig.js";

const required = { tokenParam: "hub.verify_token", challengeParam: "hub.challenge" };

describe("GET handshake configuration", () => {
  it.each([
    required,
    { ...required, matchParam: "hub.mode", matchValue: "subscribe" },
    { ...required, matchParam: "mode", matchValue: "" },
  ])("accepts a complete optional predicate: %j", (config) => {
    expect(WebhookGetHandshakeConfig.parse(config)).toEqual(config);
  });

  it.each([
    { ...required, matchParam: "hub.mode" },
    { ...required, matchValue: "subscribe" },
    { ...required, matchParam: "", matchValue: "subscribe" },
    { ...required, tokenParam: "" },
    { ...required, challengeParam: "" },
  ])("rejects incomplete predicates and empty parameter names: %j", (config) => {
    expect(WebhookGetHandshakeConfig.safeParse(config).success).toBe(false);
  });
});
