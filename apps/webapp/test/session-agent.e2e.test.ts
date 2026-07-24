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
  subscribeSessionOut,
  type CollectedPart,
} from "./helpers/sessionStream";
import { runRealChatAgent } from "./helpers/agentHarness";
import {
  testApprovalChatAgent,
  testChatAgent,
  testChatModelLocal,
  testHitlChatAgent,
  testPlainChatAgent,
  testToolChatAgent,
} from "./helpers/testChatAgent";

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

async function setupSession(agentId: string = testChatAgent.id) {
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
      taskIdentifier: agentId,
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

function actionBody(addressingKey: string, action: unknown, metadata: unknown = {}) {
  return JSON.stringify({
    kind: "message",
    payload: { chatId: addressingKey, trigger: "action", action, metadata },
  });
}

const stopBody = JSON.stringify({ kind: "stop" });

/**
 * Streams `words` as separate text-delta chunks with a delay between each, so
 * a stop signal sent after the first chunk reliably truncates the turn before
 * the model finishes.
 */
function slowModel(words: string[], delayMs: number) {
  const chunks = [
    { type: "text-start", id: "t1" },
    ...words.map((delta) => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: words.length, text: words.length, reasoning: undefined },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: chunks as never, chunkDelayInMs: delayMs }),
    }),
  });
}

function chunkType(part: CollectedPart): string | undefined {
  const c = part.chunk as { type?: unknown } | null;
  return c && typeof c === "object" && typeof c.type === "string" ? c.type : undefined;
}

const FINISH_STOP = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  },
};

/**
 * A stateful model that emits a tool-call on its first `doStream` and a plain
 * text response on every call after that. Drives both the automatic
 * tool-execute loop (one turn) and the HITL round-trip (two turns).
 */
function toolCallThenText(opts: {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  finalText: string;
}) {
  const inputJson = JSON.stringify(opts.input);
  const call1 = [
    { type: "tool-input-start", id: opts.toolCallId, toolName: opts.toolName },
    { type: "tool-input-delta", id: opts.toolCallId, delta: inputJson },
    { type: "tool-input-end", id: opts.toolCallId },
    { type: "tool-call", toolCallId: opts.toolCallId, toolName: opts.toolName, input: inputJson },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 0, reasoning: undefined },
      },
    },
  ];
  const call2 = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: opts.finalText },
    { type: "text-end", id: "t1" },
    FINISH_STOP,
  ];
  let idx = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: (idx++ === 0 ? call1 : call2) as never }),
    }),
  });
}

function joinChunks(parts: CollectedPart[]): string {
  return parts
    .filter((p) => p.chunk != null)
    .map((p) => JSON.stringify(p.chunk))
    .join("");
}

/** A model that returns `texts[i]` on its i-th `doStream` call. */
function sequenceModel(texts: string[]) {
  let idx = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const text = texts[Math.min(idx, texts.length - 1)]!;
      idx++;
      const chunks = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        FINISH_STOP,
      ];
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  });
}

function regenerateBody(addressingKey: string) {
  return JSON.stringify({
    kind: "message",
    payload: { chatId: addressingKey, trigger: "regenerate-message", metadata: {} },
  });
}

function findApprovalRequest(
  parts: CollectedPart[]
): { approvalId: string; toolCallId: string } | undefined {
  for (const p of parts) {
    const c = p.chunk as { type?: string; approvalId?: string; toolCallId?: string } | null;
    if (c && c.type === "tool-approval-request" && c.approvalId && c.toolCallId) {
      return { approvalId: c.approvalId, toolCallId: c.toolCallId };
    }
  }
  return undefined;
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

  it("EA4: onValidateMessages rejection writes an error chunk, keeps the run alive", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession();
    const agent = runRealChatAgent({
      agentId: testChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: textModel("should not appear"),
      modelLocal: testChatModelLocal,
    });

    try {
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u1",
        body: submitBody(addressingKey, userMessage("this has a blocked-word in it", "u1")),
      });

      const { parts } = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 30_000,
      });

      const errorChunk = parts.find((p) => chunkType(p) === "error");
      expect(errorChunk, "an error chunk should be written to .out").toBeTruthy();
      expect(JSON.stringify((errorChunk as CollectedPart).chunk)).toContain("content filter");
      expect(parts.some(isTurnComplete), "the turn still completes after the error").toBe(true);

      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u2",
        body: submitBody(addressingKey, userMessage("hello now", "u2")),
      });
      const follow = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.filter(isTurnComplete).length >= 2,
        maxMs: 30_000,
      });
      expect(follow.parts.filter(isTurnComplete).length).toBeGreaterThanOrEqual(2);
    } finally {
      await agent.close();
    }
  });

  it("EA5: a custom action fires onAction and completes without a turn", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession();
    const agent = runRealChatAgent({
      agentId: testChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: textModel("turn reply"),
      modelLocal: testChatModelLocal,
    });

    try {
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u1",
        body: submitBody(addressingKey, userMessage("first", "u1")),
      });
      await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 30_000,
      });

      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "act1",
        body: actionBody(addressingKey, { type: "undo" }),
      });
      const { parts } = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.filter(isTurnComplete).length >= 2,
        maxMs: 30_000,
      });

      expect(parts.filter(isTurnComplete).length).toBeGreaterThanOrEqual(2);
      expect(
        parts.find((p) => chunkType(p) === "error"),
        "no error on the action"
      ).toBeFalsy();
    } finally {
      await agent.close();
    }
  });

  it("EA6: a stop signal aborts the turn mid-stream but still completes it", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession();
    const words = Array.from({ length: 12 }, (_, i) => ` w${i}`);
    const agent = runRealChatAgent({
      agentId: testChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: slowModel(words, 250),
      modelLocal: testChatModelLocal,
    });

    try {
      const subscription = subscribeSessionOut({ baseUrl, addressingKey, token });
      const stream = await subscription.subscribe();
      const reader = stream.getReader();

      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u1",
        body: submitBody(addressingKey, userMessage("stream something long", "u1")),
      });

      const parts: CollectedPart[] = [];
      let sentStop = false;
      const deadline = performance.now() + 40_000;
      try {
        while (performance.now() < deadline) {
          const remaining = deadline - performance.now();
          const next = await Promise.race([
            reader.read(),
            new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining)),
          ]);
          if (next === "timeout" || next.done) break;
          const part = next.value as CollectedPart;
          parts.push(part);
          if (!sentStop && chunkType(part) === "text-delta") {
            sentStop = true;
            await appendInput({
              baseUrl,
              addressingKey,
              token,
              partId: "stop1",
              body: stopBody,
            });
          }
          if (parts.some(isTurnComplete)) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }

      expect(sentStop, "a text-delta arrived so a stop could be sent").toBe(true);
      expect(parts.some(isTurnComplete), "the aborted turn still writes turn-complete").toBe(true);
      const deltas = parts.filter((p) => chunkType(p) === "text-delta").length;
      expect(deltas, "generation was cut short before all deltas streamed").toBeLessThan(
        words.length
      );
    } finally {
      await agent.close();
    }
  });

  it("EA7: the agent runs a server-side tool and streams the final answer", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession(testToolChatAgent.id);
    const agent = runRealChatAgent({
      agentId: testToolChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: toolCallThenText({
        toolName: "getWeather",
        toolCallId: "tc_weather_e2e",
        input: { city: "Paris" },
        finalText: "It is 21C and clear in Paris",
      }),
      modelLocal: testChatModelLocal,
    });

    try {
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u1",
        body: submitBody(addressingKey, userMessage("what is the weather in Paris?", "u1")),
      });

      const { parts } = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 40_000,
      });

      const blob = joinChunks(parts);
      expect(blob, "the tool call is streamed to .out").toContain("getWeather");
      expect(blob, "the tool result feeds a final answer").toContain(
        "It is 21C and clear in Paris"
      );
      expect(parts.some(isTurnComplete)).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("EA8: a HITL tool round-trip parks on the call and resumes from the client answer", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession(testHitlChatAgent.id);
    const toolCallId = "tc_ask_e2e";
    const agent = runRealChatAgent({
      agentId: testHitlChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: toolCallThenText({
        toolName: "askUser",
        toolCallId,
        input: { question: "what color?" },
        finalText: "blue it is",
      }),
      modelLocal: testChatModelLocal,
    });

    try {
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u1",
        body: submitBody(addressingKey, userMessage("pick a color", "u1")),
      });
      const turn1 = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 30_000,
      });
      const blob1 = joinChunks(turn1.parts);
      expect(blob1, "turn 1 streams the tool call").toContain("askUser");
      expect(blob1).toContain(toolCallId);

      const answer = {
        id: "a-answer",
        role: "assistant",
        parts: [
          {
            type: "tool-askUser",
            toolCallId,
            state: "output-available",
            input: { question: "what color?" },
            output: { color: "blue" },
          },
        ],
      };
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u2",
        body: submitBody(addressingKey, answer),
      });
      const turn2 = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.filter(isTurnComplete).length >= 2,
        maxMs: 30_000,
      });
      expect(joinChunks(turn2.parts), "turn 2 resumes with the final answer").toContain(
        "blue it is"
      );
    } finally {
      await agent.close();
    }
  });

  it("EA9: a continuation run restores prior history from the persisted snapshot", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession(testPlainChatAgent.id);
    const runId1 = `run_persist_1_${addressingKey}`;
    const runId2 = `run_persist_2_${addressingKey}`;

    const firstRun = runRealChatAgent({
      agentId: testPlainChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: textModel("assistant acknowledges"),
      modelLocal: testChatModelLocal,
      runId: runId1,
    });
    try {
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u1",
        body: submitBody(addressingKey, userMessage("REMEMBER-THIS-42", "u1")),
      });
      await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 30_000,
      });
    } finally {
      await firstRun.close();
    }

    await appendInput({
      baseUrl,
      addressingKey,
      token,
      partId: "u2",
      body: submitBody(addressingKey, userMessage("second question", "u2")),
    });

    const secondRun = runRealChatAgent({
      agentId: testPlainChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: echoModel(),
      modelLocal: testChatModelLocal,
      runId: runId2,
      continuation: true,
      previousRunId: runId1,
    });
    try {
      const { parts } = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.filter(isTurnComplete).length >= 2,
        maxMs: 40_000,
      });
      const blob = joinChunks(parts);
      expect(blob, "the restored prior user message is back in the model prompt").toContain(
        "REMEMBER-THIS-42"
      );
      expect(blob, "the new turn also ran").toContain("second question");
    } finally {
      await secondRun.close();
    }
  });

  it("EA10: regenerate re-runs the last user turn with a fresh model call", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession(testPlainChatAgent.id);
    const agent = runRealChatAgent({
      agentId: testPlainChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: sequenceModel(["first-answer", "regenerated-answer"]),
      modelLocal: testChatModelLocal,
    });

    try {
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u1",
        body: submitBody(addressingKey, userMessage("explain it", "u1")),
      });
      const first = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 30_000,
      });
      expect(joinChunks(first.parts)).toContain("first-answer");

      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "regen1",
        body: regenerateBody(addressingKey),
      });
      const second = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.filter(isTurnComplete).length >= 2,
        maxMs: 30_000,
      });
      expect(joinChunks(second.parts), "the regenerated turn produced a fresh answer").toContain(
        "regenerated-answer"
      );
    } finally {
      await agent.close();
    }
  });

  it("EA11: a needsApproval tool parks on an approval request and runs once approved", async () => {
    const { addressingKey, token, apiKey, baseUrl } = await setupSession(testApprovalChatAgent.id);
    const toolCallId = "tc_delete_e2e";
    const agent = runRealChatAgent({
      agentId: testApprovalChatAgent.id,
      baseUrl,
      addressingKey,
      secretKey: apiKey,
      model: toolCallThenText({
        toolName: "deleteResource",
        toolCallId,
        input: { resource: "widget-1" },
        finalText: "deleted widget-1",
      }),
      modelLocal: testChatModelLocal,
    });

    try {
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u1",
        body: submitBody(addressingKey, userMessage("delete widget-1", "u1")),
      });
      const turn1 = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 30_000,
      });
      const approval = findApprovalRequest(turn1.parts);
      expect(approval, "turn 1 emits an approval request instead of executing").toBeTruthy();
      expect(joinChunks(turn1.parts), "the tool did not execute before approval").not.toContain(
        "deleted widget-1"
      );

      const answer = {
        id: "a-approval",
        role: "assistant",
        parts: [
          {
            type: "tool-deleteResource",
            toolCallId: approval!.toolCallId,
            state: "approval-responded",
            approval: { id: approval!.approvalId, approved: true },
          },
        ],
      };
      await appendInput({
        baseUrl,
        addressingKey,
        token,
        partId: "u2",
        body: submitBody(addressingKey, answer),
      });
      const turn2 = await collectSessionOut({
        baseUrl,
        addressingKey,
        token,
        until: (p) => p.filter(isTurnComplete).length >= 2,
        maxMs: 30_000,
      });
      expect(
        joinChunks(turn2.parts),
        "after approval the tool runs and the agent answers"
      ).toContain("deleted widget-1");
    } finally {
      await agent.close();
    }
  });

  it("EA12: two chats stay isolated - neither run bleeds into the other's .out", async () => {
    const chatA = await setupSession(testPlainChatAgent.id);
    const chatB = await setupSession(testPlainChatAgent.id);

    const agentA = runRealChatAgent({
      agentId: testPlainChatAgent.id,
      baseUrl: chatA.baseUrl,
      addressingKey: chatA.addressingKey,
      secretKey: chatA.apiKey,
      model: textModel("answer-for-A"),
      modelLocal: testChatModelLocal,
    });
    try {
      await appendInput({
        baseUrl: chatA.baseUrl,
        addressingKey: chatA.addressingKey,
        token: chatA.token,
        partId: "a1",
        body: submitBody(chatA.addressingKey, userMessage("hi from A", "a1")),
      });
      await collectSessionOut({
        baseUrl: chatA.baseUrl,
        addressingKey: chatA.addressingKey,
        token: chatA.token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 30_000,
      });
    } finally {
      await agentA.close();
    }

    const agentB = runRealChatAgent({
      agentId: testPlainChatAgent.id,
      baseUrl: chatB.baseUrl,
      addressingKey: chatB.addressingKey,
      secretKey: chatB.apiKey,
      model: textModel("answer-for-B"),
      modelLocal: testChatModelLocal,
    });
    try {
      await appendInput({
        baseUrl: chatB.baseUrl,
        addressingKey: chatB.addressingKey,
        token: chatB.token,
        partId: "b1",
        body: submitBody(chatB.addressingKey, userMessage("hi from B", "b1")),
      });
      await collectSessionOut({
        baseUrl: chatB.baseUrl,
        addressingKey: chatB.addressingKey,
        token: chatB.token,
        until: (p) => p.some(isTurnComplete),
        maxMs: 30_000,
      });
    } finally {
      await agentB.close();
    }

    const outA = joinChunks(
      (
        await collectSessionOut({
          baseUrl: chatA.baseUrl,
          addressingKey: chatA.addressingKey,
          token: chatA.token,
          until: (p) => p.some(isTurnComplete),
          maxMs: 15_000,
        })
      ).parts
    );
    const outB = joinChunks(
      (
        await collectSessionOut({
          baseUrl: chatB.baseUrl,
          addressingKey: chatB.addressingKey,
          token: chatB.token,
          until: (p) => p.some(isTurnComplete),
          maxMs: 15_000,
        })
      ).parts
    );

    expect(outA).toContain("answer-for-A");
    expect(outA, "A's stream never sees B's output").not.toContain("answer-for-B");
    expect(outB).toContain("answer-for-B");
    expect(outB, "B's stream never sees A's output").not.toContain("answer-for-A");
  });
});
