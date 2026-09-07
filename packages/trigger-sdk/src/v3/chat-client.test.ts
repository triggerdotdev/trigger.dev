import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClientManager } from "@trigger.dev/core/v3";

import { AgentChat } from "./chat-client.js";

// ── Helpers ────────────────────────────────────────────────────────────

const SESSION_PAT = "pat_test";

function createSessionResponse(externalId: string): Response {
  return new Response(
    JSON.stringify({
      id: "session_test",
      externalId,
      type: "chat.agent",
      taskIdentifier: "test-agent",
      triggerConfig: { basePayload: { chatId: externalId } },
      currentRunId: "run_test",
      runId: "run_test",
      publicAccessToken: SESSION_PAT,
      tags: [],
      metadata: null,
      closedAt: null,
      closedReason: null,
      expiresAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCached: true,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function appendOkResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function withApiContext<T>(fn: () => Promise<T>): Promise<T> {
  return apiClientManager.runWithConfig(
    { baseURL: "https://api.test.trigger.dev", secretKey: "tr_test_secret" },
    fn
  );
}

/**
 * Records the `triggerConfig` of every `POST /api/v1/sessions`, which is the
 * only request that writes a session's deployment pin.
 */
function stubFetchCapturingSessionStarts(): Array<Record<string, unknown> | undefined> {
  const starts: Array<Record<string, unknown> | undefined> = [];
  global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (/\/api\/v1\/sessions\/?$/.test(urlStr)) {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      starts.push(body.triggerConfig as Record<string, unknown> | undefined);
      return createSessionResponse(String(body.externalId ?? "chat-1"));
    }
    if (urlStr.includes("/realtime/v1/sessions/") && urlStr.endsWith("/in/append")) {
      return appendOkResponse();
    }
    if (urlStr.includes("/realtime/v1/sessions/") && urlStr.endsWith("/out")) {
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  }) as never;
  return starts;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("AgentChat session restoration", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("refreshes a restored session's deployment pin", async () => {
    // A conversation loaded from the caller's own store is already started, by
    // an earlier request, under whatever deployment THAT release resolved.
    // Only `sessions.start` rewrites the stored config, so skipping it here is
    // what left a persisted conversation pinned to the release it began on for
    // the rest of its life — long after the app had moved on.
    const starts = stubFetchCapturingSessionStarts();

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-restored",
        session: { lastEventId: "42" },
        triggerConfig: { basePayload: {}, externalDeploymentId: "release-new" },
      });

      await chat.sendRaw([{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]);

      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ externalDeploymentId: "release-new" });
      // The persisted cursor is what makes it a restore rather than a new chat.
      expect(chat.session.lastEventId).toBe("42");
    });
  });

  it("refreshes the pin once per instance, not once per message", async () => {
    const starts = stubFetchCapturingSessionStarts();

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-restored-twice",
        session: { lastEventId: "7" },
        triggerConfig: { basePayload: {}, externalDeploymentId: "release-new" },
      });

      await chat.sendRaw([{ id: "u1", role: "user", parts: [{ type: "text", text: "one" }] }]);
      await chat.sendRaw([{ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] }]);

      expect(starts).toHaveLength(1);
    });
  });

  it("does not fire onTriggered when a restored session refreshes", async () => {
    // Documented as the initial start. A caller whose hook writes a row would
    // otherwise write it again on every request that rehydrates the chat.
    stubFetchCapturingSessionStarts();
    const triggered: string[] = [];

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-restored-hook",
        session: { lastEventId: "9" },
        onTriggered: ({ runId }) => {
          triggered.push(runId);
        },
      });

      await chat.sendRaw([{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]);

      expect(triggered).toEqual([]);
    });
  });

  it("still fires onTriggered for a chat that was never started", async () => {
    stubFetchCapturingSessionStarts();
    const triggered: string[] = [];

    await withApiContext(async () => {
      const chat = new AgentChat({
        agent: "test-agent",
        id: "chat-fresh",
        onTriggered: ({ runId }) => {
          triggered.push(runId);
        },
      });

      await chat.sendRaw([{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]);

      expect(triggered).toEqual(["run_test"]);
    });
  });
});
