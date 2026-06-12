import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { CreateSessionRequestBody, CreatedSessionResponseBody } from "@trigger.dev/core/v3";

import { chat } from "./ai.js";
import {
  __setSessionStartImplForTests,
  __setSessionOpenImplForTests,
  SessionHandle,
} from "./sessions.js";
import { apiClientManager } from "@trigger.dev/core/v3";

// `auth.createPublicToken` is called by the action when no start token is
// supplied. Provide a minimal API client config so the mint path doesn't
// throw before we get to assert the captured request body.
apiClientManager.setGlobalAPIClientConfiguration({
  baseURL: "https://example.invalid",
  accessToken: "tr_test_secret",
});

// Capture the request body the action would send to `sessions.start()`.
let lastStartBody: CreateSessionRequestBody | undefined;

function installStartFixture() {
  __setSessionStartImplForTests(async (body): Promise<CreatedSessionResponseBody> => {
    lastStartBody = body;
    return {
      id: "session_fixture",
      externalId: body.externalId ?? null,
      type: body.type,
      taskIdentifier: body.taskIdentifier,
      triggerConfig: body.triggerConfig,
      currentRunId: "run_fixture",
      tags: body.triggerConfig.tags ?? [],
      metadata: body.metadata ?? null,
      closedAt: null,
      closedReason: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      runId: "run_fixture",
      publicAccessToken: "tr_pat_fixture",
      isCached: false,
    };
  });
  __setSessionOpenImplForTests(() => new SessionHandle("session_fixture"));
}

afterEach(() => {
  __setSessionStartImplForTests(undefined);
  __setSessionOpenImplForTests(undefined);
  lastStartBody = undefined;
});

// Build a fake chat agent task shape that the generic can narrow against.
// We only need the static type — the runtime never invokes this task because
// `__setSessionStartImplForTests` intercepts the network call.
const fakeChat = chat
  .withClientData({
    schema: z.object({
      userId: z.string(),
      plan: z.enum(["free", "pro"]),
    }),
  })
  .agent({
    id: "fake-chat",
    run: async () => undefined as any,
  });

describe("chat.createStartSessionAction — runtime", () => {
  it("folds typed clientData into basePayload.metadata so onChatStart sees it on the first turn", async () => {
    installStartFixture();

    const start = chat.createStartSessionAction<typeof fakeChat>("fake-chat");

    const result = await start({
      chatId: "chat-1",
      clientData: { userId: "u-1", plan: "pro" },
    });

    expect(result.publicAccessToken).toBe("tr_pat_fixture");
    expect(lastStartBody?.triggerConfig.basePayload).toMatchObject({
      messages: [],
      trigger: "preload",
      metadata: { userId: "u-1", plan: "pro" },
      chatId: "chat-1",
    });
  });

  it("leaves basePayload.metadata unset when clientData is not provided", async () => {
    installStartFixture();

    const start = chat.createStartSessionAction("fake-chat");
    await start({ chatId: "chat-2" });

    expect(lastStartBody?.triggerConfig.basePayload).not.toHaveProperty("metadata");
  });

  it("prepends chat:{chatId} to triggerConfig.tags and caps at 5", async () => {
    installStartFixture();

    const start = chat.createStartSessionAction("fake-chat", {
      triggerConfig: {
        tags: ["org:acme", "a", "b", "c", "d", "e"],
      },
    });
    await start({ chatId: "chat-tags" });

    expect(lastStartBody?.triggerConfig.tags).toEqual([
      "chat:chat-tags",
      "org:acme",
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps session-level metadata distinct from per-turn clientData", async () => {
    installStartFixture();

    const start = chat.createStartSessionAction<typeof fakeChat>("fake-chat");
    await start({
      chatId: "chat-3",
      clientData: { userId: "u-3", plan: "free" },
      metadata: { source: "marketing-site" },
    });

    // Per-turn shape (visible to onPreload / onChatStart):
    expect(lastStartBody?.triggerConfig.basePayload).toMatchObject({
      metadata: { userId: "u-3", plan: "free" },
    });
    // Session-row metadata (opaque, never typed via clientDataSchema):
    expect(lastStartBody?.metadata).toEqual({ source: "marketing-site" });
  });
});

describe("chat.createStartSessionAction — types", () => {
  it("narrows clientData against the chat agent's clientDataSchema", () => {
    const start = chat.createStartSessionAction<typeof fakeChat>("fake-chat");

    // The clientData field is typed off the agent's schema.
    expectTypeOf<Parameters<typeof start>[0]["clientData"]>().toEqualTypeOf<
      { userId: string; plan: "free" | "pro" } | undefined
    >();
    // The agent's typed clientData is strictly narrower than `unknown`.
    expectTypeOf<Parameters<typeof start>[0]["clientData"]>().not.toEqualTypeOf<unknown>();
  });

  it("defaults clientData to unknown when called without a generic", () => {
    const start = chat.createStartSessionAction("fake-chat");
    expectTypeOf(start).parameter(0).toHaveProperty("clientData");
    // Untyped variant — clientData is `unknown`.
    expectTypeOf<Parameters<typeof start>[0]["clientData"]>().toEqualTypeOf<unknown>();
  });
});
