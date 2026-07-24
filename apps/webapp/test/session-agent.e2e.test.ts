/**
 * Tier-1 agent e2e: the real chat.agent turn loop against the full stack.
 *
 * Boots the testcontainer stack (webapp + Postgres + Redis + s2-lite + MinIO),
 * runs the genuine `chat.agent` run loop in-process wired to the real webapp
 * Session streams (real S2 `.out`/`.in` + object-store snapshots), with the
 * language model injected as a deterministic MockLanguageModelV3. Turns are
 * driven by appending to `.in` over HTTP; output is read back through the real
 * SSE proxy. No real LLM, no `trigger dev`.
 *
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "@trigger.dev/sdk/ai/test";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { SessionStreamTestServer } from "@internal/testcontainers/webapp";
import { startSessionStreamTestServer } from "@internal/testcontainers/webapp";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import {
  appendInput,
  collectSessionOut,
  isTurnComplete,
  mintSessionToken,
} from "./helpers/sessionStream";
import { runRealChatAgent } from "./helpers/agentHarness";
import { testChatAgent, testChatModelLocal } from "./helpers/testChatAgent";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let server: SessionStreamTestServer;

beforeAll(async () => {
  server = await startSessionStreamTestServer();
}, 240_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

function textModel(text: string) {
  const chunks = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: chunks as never }) }),
  });
}

async function setupSession() {
  const { organization, project, environment, apiKey } = await seedTestEnvironment(server.prisma);
  const addressingKey = `chat-${randomBytes(6).toString("hex")}`;
  await server.prisma.session.create({
    data: {
      friendlyId: `session_${randomBytes(8).toString("hex")}`,
      externalId: addressingKey,
      type: "chat.agent",
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      environmentType: environment.type,
      organizationId: organization.id,
      taskIdentifier: testChatAgent.id,
      triggerConfig: { basePayload: {} },
    },
  });
  const token = await mintSessionToken({ apiKey, envId: environment.id, addressingKey });
  return { addressingKey, token, apiKey, baseUrl: server.webapp.baseUrl };
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  let out = "";
  for (const m of prompt) {
    const c = (m as { content?: unknown }).content;
    if (typeof c === "string") out += `${c} `;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
          out += `${(part as { text?: string }).text ?? ""} `;
        }
      }
    }
  }
  return out;
}

function echoModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const text = promptText(prompt).trim();
      const chunks = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: `echo:${text}` },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ];
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  });
}

function userMessage(text: string, id = "u0") {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function submitBody(addressingKey: string, message: unknown, metadata: unknown = {}) {
  return JSON.stringify({
    kind: "message",
    payload: { message, chatId: addressingKey, trigger: "submit-message", metadata },
  });
}

describe("session agent e2e (real chat.agent loop)", () => {
  it("EA1: a real agent turn streams assistant text to .out", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession();
    const agent = runRealChatAgent({
      agentId: testChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: textModel("hello from the agent"),
      modelLocal: testChatModelLocal,
    });

    try {
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u0",
        body: submitBody(addressingKey, userMessage("hi")),
      });

      const { parts } = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 30_000,
      });

      const text = parts
        .filter((p) => p.chunk != null)
        .map((p) => JSON.stringify(p.chunk))
        .join("");
      expect(text).toContain("hello from the agent");
      expect(parts.some(isTurnComplete)).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("EA2: two turns continue on the same run", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession();
    const agent = runRealChatAgent({
      agentId: testChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: textModel("reply"),
      modelLocal: testChatModelLocal,
    });

    try {
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u1",
        body: submitBody(addressingKey, userMessage("one", "u1")),
      });
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u2",
        body: submitBody(addressingKey, userMessage("two", "u2")),
      });

      const { parts } = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.filter(isTurnComplete).length >= 2,
        maxMs: 40_000,
      });

      expect(parts.filter(isTurnComplete)).toHaveLength(2);
      const replyText = parts
        .filter((p) => p.chunk != null)
        .map((p) => JSON.stringify(p.chunk))
        .join("");
      expect((replyText.match(/reply/g) ?? []).length).toBeGreaterThanOrEqual(2);
      const seqs = parts.map((p) => Number(p.id));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    } finally {
      await agent.close();
    }
  });

  it("EA3: hydrateMessages injects prior history into the turn", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession();
    const agent = runRealChatAgent({
      agentId: testChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: echoModel(),
      modelLocal: testChatModelLocal,
    });

    try {
      const hydrated = [
        { id: "h1", role: "user", parts: [{ type: "text", text: "HISTORY-MARKER" }] },
        { id: "h2", role: "assistant", parts: [{ type: "text", text: "prior reply" }] },
      ];
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u1",
        body: submitBody(addressingKey, userMessage("current question", "u1"), { hydrated }),
      });

      const { parts } = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 30_000,
      });

      const text = parts
        .filter((p) => p.chunk != null)
        .map((p) => JSON.stringify(p.chunk))
        .join("");
      expect(text).toContain("HISTORY-MARKER");
      expect(text).toContain("current question");
    } finally {
      await agent.close();
    }
  });
});
