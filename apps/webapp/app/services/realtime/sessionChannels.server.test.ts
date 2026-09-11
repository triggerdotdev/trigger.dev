import { buildJwtAbility } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import {
  isSafeSessionExternalId,
  SESSION_CHANNEL_SCOPE_INFIX,
  sessionChannelResources,
  sessionStreamResources,
} from "./sessionChannels.server";

describe("isSafeSessionExternalId", () => {
  it("rejects an externalId that collides with the channel-scope fold", () => {
    expect(isSafeSessionExternalId(`session_abc${SESSION_CHANNEL_SCOPE_INFIX}screencast`)).toBe(
      false
    );
    expect(isSafeSessionExternalId(":channels:")).toBe(false);
    expect(isSafeSessionExternalId("a:channels:b:channels:c")).toBe(false);
  });

  it("rejects an externalId that collides with the direction fold", () => {
    expect(isSafeSessionExternalId("session_abc:out")).toBe(false);
    expect(isSafeSessionExternalId("session_abc:in")).toBe(false);
    expect(isSafeSessionExternalId(":out")).toBe(false);
  });

  it("allows normal externalIds, including single colons that are not the fold infix", () => {
    expect(isSafeSessionExternalId("chat-3c3a1756-a49a-4c78-891a-51f78596c984")).toBe(true);
    expect(isSafeSessionExternalId("user:123")).toBe(true);
    expect(isSafeSessionExternalId("org:abc:chat:1")).toBe(true);
    expect(isSafeSessionExternalId("channels")).toBe(true);
    expect(isSafeSessionExternalId("plain")).toBe(true);
    // Only the exact `:out` / `:in` suffix folds; these merely contain or end with the word.
    expect(isSafeSessionExternalId("checkout")).toBe(true);
    expect(isSafeSessionExternalId("login")).toBe(true);
    expect(isSafeSessionExternalId("chat:out:1")).toBe(true);
  });

  it("keeps a narrowed token's folded id from equaling any allowed session's bare key", () => {
    const foldedIds = [
      ...sessionChannelResources("screencast", ["session_abc"], "out"),
      ...sessionStreamResources("out", ["session_abc"]),
      ...sessionStreamResources("in", ["session_abc"]),
    ]
      .map((r) => r.id)
      .filter((id) => id !== "session_abc");

    expect(foldedIds.length).toBe(4);
    for (const foldedId of foldedIds) {
      expect(isSafeSessionExternalId(foldedId)).toBe(false);
    }
  });
});

describe("sessionStreamResources", () => {
  const keys = ["chat_abc", "session_123"];

  it("lets read:sessions:{id}:out read .out but not .in", () => {
    const ability = buildJwtAbility(["read:sessions:chat_abc:out"]);
    expect(ability.can("read", sessionStreamResources("out", keys))).toBe(true);
    expect(ability.can("read", sessionStreamResources("in", keys))).toBe(false);
  });

  it("keeps read:sessions:{id} matching both streams", () => {
    const ability = buildJwtAbility(["read:sessions:chat_abc"]);
    expect(ability.can("read", sessionStreamResources("out", keys))).toBe(true);
    expect(ability.can("read", sessionStreamResources("in", keys))).toBe(true);
  });

  it("never authorizes a legacy externalId that equals another session's folded id", () => {
    // A row created before the direction fold existed may carry externalId `chat_abc:out`.
    // A token narrowed to session `chat_abc`'s .out stream must not read that other session.
    const narrowed = buildJwtAbility(["read:sessions:chat_abc:out"]);
    const legacyKeys = ["chat_abc:out", "session_legacy"];
    expect(narrowed.can("read", sessionStreamResources("out", legacyKeys))).toBe(false);
    expect(narrowed.can("read", sessionStreamResources("in", legacyKeys))).toBe(false);
    expect(narrowed.can("read", sessionChannelResources("tools", legacyKeys, "out"))).toBe(false);
    // Same for a pre-guard `:channels:` externalId against a channel-narrowed token.
    const channel = buildJwtAbility(["read:sessions:chat_abc:channels:tools"]);
    expect(channel.can("read", sessionStreamResources("out", ["chat_abc:channels:tools"]))).toBe(
      false
    );
    // The legacy row stays reachable by friendlyId and by a type-level scope.
    expect(
      buildJwtAbility(["read:sessions:session_legacy"]).can(
        "read",
        sessionStreamResources("out", legacyKeys)
      )
    ).toBe(true);
    expect(
      buildJwtAbility(["read:sessions"]).can("read", sessionStreamResources("out", legacyKeys))
    ).toBe(true);
    // An unsafe key contributes no resource at all.
    expect(sessionStreamResources("out", ["chat_abc:out"])).toEqual([]);
  });

  it("does not let a direction-scoped token match the bare session", () => {
    const ability = buildJwtAbility(["read:sessions:chat_abc:out"]);
    expect(ability.can("read", { type: "sessions", id: "chat_abc" })).toBe(false);
    expect(ability.can("read", { type: "sessions", id: "session_123" })).toBe(false);
  });
});

describe("sessionChannelResources", () => {
  const keys = ["chat_abc"];

  it("lets a channel token read either direction and a channel:out token only .out", () => {
    const channelWide = buildJwtAbility(["read:sessions:chat_abc:channels:tools"]);
    expect(channelWide.can("read", sessionChannelResources("tools", keys, "out"))).toBe(true);
    expect(channelWide.can("read", sessionChannelResources("tools", keys, "in"))).toBe(true);

    const outOnly = buildJwtAbility(["read:sessions:chat_abc:channels:tools:out"]);
    expect(outOnly.can("read", sessionChannelResources("tools", keys, "out"))).toBe(true);
    expect(outOnly.can("read", sessionChannelResources("tools", keys, "in"))).toBe(false);
    expect(outOnly.can("read", sessionChannelResources("other", keys, "out"))).toBe(false);
  });

  it("does not let a default-stream :out token read a named channel", () => {
    const ability = buildJwtAbility(["read:sessions:chat_abc:out"]);
    expect(ability.can("read", sessionChannelResources("tools", keys, "out"))).toBe(false);
  });
});
