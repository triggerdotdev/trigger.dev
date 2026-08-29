import { describe, expect, it } from "vitest";
import {
  isSafeSessionExternalId,
  SESSION_CHANNEL_SCOPE_INFIX,
  sessionChannelResources,
} from "./sessionChannels.server";

describe("isSafeSessionExternalId", () => {
  it("rejects an externalId that collides with the channel-scope fold", () => {
    expect(isSafeSessionExternalId(`session_abc${SESSION_CHANNEL_SCOPE_INFIX}screencast`)).toBe(
      false
    );
    expect(isSafeSessionExternalId(":channels:")).toBe(false);
    expect(isSafeSessionExternalId("a:channels:b:channels:c")).toBe(false);
  });

  it("allows normal externalIds, including single colons that are not the fold infix", () => {
    expect(isSafeSessionExternalId("chat-3c3a1756-a49a-4c78-891a-51f78596c984")).toBe(true);
    expect(isSafeSessionExternalId("user:123")).toBe(true);
    expect(isSafeSessionExternalId("org:abc:chat:1")).toBe(true);
    expect(isSafeSessionExternalId("channels")).toBe(true);
    expect(isSafeSessionExternalId("plain")).toBe(true);
  });

  it("keeps a channel-scoped token's folded id from equaling any allowed session's bare key", () => {
    const channel = "screencast";
    const foldedIds = sessionChannelResources(channel, ["session_abc"])
      .map((r) => r.id)
      .filter((id) => id.includes(SESSION_CHANNEL_SCOPE_INFIX));

    for (const foldedId of foldedIds) {
      expect(isSafeSessionExternalId(foldedId)).toBe(false);
    }
  });
});
