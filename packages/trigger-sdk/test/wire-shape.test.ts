// The slim wire payload shape is the contract between the transport
// (`TriggerChatTransport.sendMessages` etc.) and the agent runtime. This
// test locks the shape down at the type and JSON-roundtrip level so a
// future change either holds the wire stable or breaks loudly.
//
// Plan F.1: verify `messages` is gone, `message`/`headStartMessages` are
// typed correctly. See plan section A.1.

import "../src/v3/test/index.js";

import type { UIMessage } from "ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChatInputChunk, ChatTaskWirePayload } from "../src/v3/ai-shared.js";
import { slimSubmitMessageForWire, upsertIncomingMessage } from "../src/v3/ai-shared.js";

describe("ChatTaskWirePayload (slim wire shape)", () => {
  it("encodes and decodes a submit-message payload through JSON", () => {
    const userMsg: UIMessage = {
      id: "u-1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    };
    const wire: ChatTaskWirePayload = {
      message: userMsg,
      chatId: "chat-1",
      trigger: "submit-message",
      metadata: { userId: "u-1" },
    };

    const encoded = JSON.stringify(wire);
    const decoded = JSON.parse(encoded) as ChatTaskWirePayload;

    expect(decoded).toEqual(wire);
    expect(decoded.message).toEqual(userMsg);
    expect(decoded.trigger).toBe("submit-message");
  });

  it("encodes and decodes a regenerate-message payload (no message body)", () => {
    const wire: ChatTaskWirePayload = {
      chatId: "chat-1",
      trigger: "regenerate-message",
      metadata: undefined,
    };

    const decoded = JSON.parse(JSON.stringify(wire)) as ChatTaskWirePayload;

    expect(decoded.trigger).toBe("regenerate-message");
    expect(decoded.message).toBeUndefined();
    expect(decoded.headStartMessages).toBeUndefined();
  });

  it("encodes and decodes a handover-prepare payload with headStartMessages", () => {
    const history: UIMessage[] = [
      {
        id: "u-1",
        role: "user",
        parts: [{ type: "text", text: "first" }],
      },
      {
        id: "a-1",
        role: "assistant",
        parts: [{ type: "text", text: "ok" }],
      },
    ];
    const wire: ChatTaskWirePayload = {
      headStartMessages: history,
      chatId: "chat-1",
      trigger: "handover-prepare",
    };

    const decoded = JSON.parse(JSON.stringify(wire)) as ChatTaskWirePayload;

    expect(decoded.headStartMessages).toEqual(history);
    expect(decoded.message).toBeUndefined();
  });

  it("encodes and decodes a preload payload (no message, no headStartMessages)", () => {
    const wire: ChatTaskWirePayload = {
      chatId: "chat-1",
      trigger: "preload",
    };

    const decoded = JSON.parse(JSON.stringify(wire)) as ChatTaskWirePayload;
    expect(decoded.trigger).toBe("preload");
    expect(decoded.message).toBeUndefined();
    expect(decoded.headStartMessages).toBeUndefined();
  });

  it("encodes and decodes a close payload", () => {
    const wire: ChatTaskWirePayload = {
      chatId: "chat-1",
      trigger: "close",
    };
    const decoded = JSON.parse(JSON.stringify(wire)) as ChatTaskWirePayload;
    expect(decoded.trigger).toBe("close");
  });

  it("encodes and decodes an action payload (carries `action`, no message)", () => {
    const wire: ChatTaskWirePayload = {
      chatId: "chat-1",
      trigger: "action",
      action: { type: "undo" },
    };
    const decoded = JSON.parse(JSON.stringify(wire)) as ChatTaskWirePayload;

    expect(decoded.trigger).toBe("action");
    expect(decoded.action).toEqual({ type: "undo" });
    expect(decoded.message).toBeUndefined();
  });

  it("preserves continuation / previousRunId / sessionId across the wire", () => {
    const wire: ChatTaskWirePayload = {
      message: {
        id: "u-2",
        role: "user",
        parts: [{ type: "text", text: "continued" }],
      },
      chatId: "chat-1",
      trigger: "submit-message",
      continuation: true,
      previousRunId: "run_abc",
      sessionId: "sess_xyz",
      idleTimeoutInSeconds: 42,
    };
    const decoded = JSON.parse(JSON.stringify(wire)) as ChatTaskWirePayload;

    expect(decoded.continuation).toBe(true);
    expect(decoded.previousRunId).toBe("run_abc");
    expect(decoded.sessionId).toBe("sess_xyz");
    expect(decoded.idleTimeoutInSeconds).toBe(42);
  });

  it("preserves a tool-approval-responded assistant message in `message`", () => {
    // The HITL slim-wire path sends an assistant message with
    // `state: "approval-responded"` tool parts in `message`, not the
    // full chain. The agent merges by id.
    const approvalMsg: UIMessage = {
      id: "a-1",
      role: "assistant",
      parts: [
        {
          type: "tool-search",
          toolCallId: "tc-42",
          state: "output-available",
          input: { q: "x" },
          output: { hits: 7 },
        } as never,
      ],
    };
    const wire: ChatTaskWirePayload = {
      message: approvalMsg,
      chatId: "chat-1",
      trigger: "submit-message",
    };

    const decoded = JSON.parse(JSON.stringify(wire)) as ChatTaskWirePayload;
    expect(decoded.message).toEqual(approvalMsg);
  });
});

describe("upsertIncomingMessage", () => {
  const userMsg = (id: string, text: string): UIMessage => ({
    id,
    role: "user",
    parts: [{ type: "text", text }],
  });

  it("pushes a fresh user message and returns true", () => {
    const stored: UIMessage[] = [userMsg("u-1", "first")];
    const mutated = upsertIncomingMessage(stored, {
      trigger: "submit-message",
      incomingMessages: [userMsg("u-2", "second")],
    });
    expect(mutated).toBe(true);
    expect(stored).toHaveLength(2);
    expect(stored[1]!.id).toBe("u-2");
  });

  it("no-ops when incoming id is already in stored (HITL continuation)", () => {
    const head = {
      id: "asst-1",
      role: "assistant" as const,
      parts: [
        { type: "tool-search", toolCallId: "tc-1", state: "input-available", input: {} } as never,
      ],
    };
    const stored: UIMessage[] = [userMsg("u-1", "hi"), head];
    const slim = {
      id: "asst-1",
      role: "assistant" as const,
      parts: [
        { type: "tool-search", toolCallId: "tc-1", state: "output-available", output: {} } as never,
      ],
    };
    const mutated = upsertIncomingMessage(stored, {
      trigger: "submit-message",
      incomingMessages: [slim],
    });
    expect(mutated).toBe(false);
    expect(stored).toHaveLength(2);
    // The original head is untouched — the runtime's per-turn merge
    // overlays the resolution; the customer's stored array is just
    // the pre-merge snapshot.
    expect(stored[1]).toBe(head);
  });

  it("no-ops on regenerate-message trigger", () => {
    const stored: UIMessage[] = [userMsg("u-1", "hi")];
    const mutated = upsertIncomingMessage(stored, {
      trigger: "regenerate-message",
      incomingMessages: [userMsg("u-2", "ignored")],
    });
    expect(mutated).toBe(false);
    expect(stored).toHaveLength(1);
  });

  it("no-ops on action trigger", () => {
    const stored: UIMessage[] = [userMsg("u-1", "hi")];
    const mutated = upsertIncomingMessage(stored, {
      trigger: "action",
      incomingMessages: [],
    });
    expect(mutated).toBe(false);
    expect(stored).toHaveLength(1);
  });

  it("no-ops on empty incomingMessages", () => {
    const stored: UIMessage[] = [userMsg("u-1", "hi")];
    const mutated = upsertIncomingMessage(stored, {
      trigger: "submit-message",
      incomingMessages: [],
    });
    expect(mutated).toBe(false);
    expect(stored).toHaveLength(1);
  });

  it("only inspects the last incoming message (slim wire ships at most one)", () => {
    const stored: UIMessage[] = [userMsg("u-1", "hi")];
    const mutated = upsertIncomingMessage(stored, {
      trigger: "submit-message",
      incomingMessages: [userMsg("ignored", "ignored"), userMsg("u-3", "new")],
    });
    expect(mutated).toBe(true);
    expect(stored).toHaveLength(2);
    expect(stored[1]!.id).toBe("u-3");
  });

  it("pushes when newMsg has no id (no dedup possible)", () => {
    const stored: UIMessage[] = [userMsg("u-1", "hi")];
    const incoming = {
      role: "user",
      parts: [{ type: "text", text: "no id" }],
    } as unknown as UIMessage;
    const mutated = upsertIncomingMessage(stored, {
      trigger: "submit-message",
      incomingMessages: [incoming],
    });
    expect(mutated).toBe(true);
    expect(stored).toHaveLength(2);
  });

  it("accepts the full hydrateMessages event without re-packaging", () => {
    // Customers can pass the destructured event directly — the helper
    // only reads `trigger` + `incomingMessages` but ignores any other
    // fields the event happens to carry.
    const stored: UIMessage[] = [];
    const event = {
      chatId: "chat-1",
      turn: 0,
      trigger: "submit-message" as const,
      incomingMessages: [userMsg("u-1", "hi")],
      previousMessages: [],
      continuation: false,
    };
    const mutated = upsertIncomingMessage(stored, event);
    expect(mutated).toBe(true);
    expect(stored).toHaveLength(1);
  });
});

describe("slimSubmitMessageForWire", () => {
  it("passes user messages through unchanged", () => {
    const userMsg: UIMessage = {
      id: "u-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    };
    expect(slimSubmitMessageForWire(userMsg)).toBe(userMsg);
  });

  it("passes assistant messages with no resolved tool parts through unchanged", () => {
    const assistantMsg: UIMessage = {
      id: "a-1",
      role: "assistant",
      parts: [
        { type: "text", text: "thinking..." },
        {
          type: "tool-search",
          toolCallId: "tc-1",
          state: "input-available",
          input: { q: "x" },
        } as never,
      ],
    };
    expect(slimSubmitMessageForWire(assistantMsg)).toBe(assistantMsg);
  });

  it("slims output-available HITL continuation to {type, toolCallId, state, output}", () => {
    const assistantMsg: UIMessage = {
      id: "a-1",
      role: "assistant",
      parts: [
        { type: "text", text: "let me search" },
        { type: "reasoning", text: "long reasoning blob..." } as never,
        {
          type: "tool-search",
          toolCallId: "tc-1",
          state: "output-available",
          input: { q: "very long query".repeat(1000) },
          output: { hits: 7 },
        } as never,
      ],
    };
    const slim = slimSubmitMessageForWire(assistantMsg);
    expect(slim).toEqual({
      id: "a-1",
      role: "assistant",
      parts: [
        {
          type: "tool-search",
          toolCallId: "tc-1",
          state: "output-available",
          output: { hits: 7 },
        },
      ],
    });
    // The slim drops `input` (server has it via hydrate/snapshot) — the
    // wire is much smaller than the original.
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(assistantMsg).length / 50);
  });

  it("slims output-error to {type, toolCallId, state, errorText}", () => {
    const assistantMsg: UIMessage = {
      id: "a-1",
      role: "assistant",
      parts: [
        {
          type: "tool-search",
          toolCallId: "tc-1",
          state: "output-error",
          input: { q: "x" },
          errorText: "boom",
        } as never,
      ],
    };
    expect(slimSubmitMessageForWire(assistantMsg)).toEqual({
      id: "a-1",
      role: "assistant",
      parts: [
        {
          type: "tool-search",
          toolCallId: "tc-1",
          state: "output-error",
          errorText: "boom",
        },
      ],
    });
  });

  it("slims approval-responded to {type, toolCallId, state, approval}", () => {
    const assistantMsg: UIMessage = {
      id: "a-1",
      role: "assistant",
      parts: [
        {
          type: "tool-delete",
          toolCallId: "tc-1",
          state: "approval-responded",
          input: { path: "/critical" },
          approval: { id: "appr_1", approved: true, reason: "looks fine" },
        } as never,
      ],
    };
    expect(slimSubmitMessageForWire(assistantMsg)).toEqual({
      id: "a-1",
      role: "assistant",
      parts: [
        {
          type: "tool-delete",
          toolCallId: "tc-1",
          state: "approval-responded",
          approval: { id: "appr_1", approved: true, reason: "looks fine" },
        },
      ],
    });
  });

  it("slims dynamic-tool parts and preserves toolName", () => {
    const assistantMsg: UIMessage = {
      id: "a-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "dyn-search",
          toolCallId: "tc-1",
          state: "output-available",
          input: { q: "x" },
          output: { hits: 1 },
        } as never,
      ],
    };
    expect(slimSubmitMessageForWire(assistantMsg)).toEqual({
      id: "a-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "dyn-search",
          toolCallId: "tc-1",
          state: "output-available",
          output: { hits: 1 },
        },
      ],
    });
  });

  it("only slims the advanced tool parts when an assistant has mixed states", () => {
    const assistantMsg: UIMessage = {
      id: "a-1",
      role: "assistant",
      parts: [
        { type: "text", text: "thinking" },
        {
          type: "tool-search",
          toolCallId: "tc-resolved",
          state: "output-available",
          input: { q: "x" },
          output: { hits: 1 },
        } as never,
        {
          type: "tool-askUser",
          toolCallId: "tc-still-pending",
          state: "input-available",
          input: { q: "ok?" },
        } as never,
      ],
    };
    const slim = slimSubmitMessageForWire(assistantMsg);
    expect(slim?.parts).toHaveLength(1);
    expect((slim?.parts?.[0] as any).toolCallId).toBe("tc-resolved");
  });

  it("handles undefined input", () => {
    expect(slimSubmitMessageForWire(undefined)).toBeUndefined();
  });
});

describe("ChatTaskWirePayload (compile-time shape)", () => {
  it("does NOT have a `messages` array field (slim wire removed it)", () => {
    // If a future edit reintroduces `messages: TMessage[]`, this assertion
    // forces a compile error rather than letting the wire silently grow
    // back.
    type WirePayloadKeys = keyof ChatTaskWirePayload;
    expectTypeOf<WirePayloadKeys>().not.toEqualTypeOf<
      "messages" | Exclude<WirePayloadKeys, "messages">
    >();
    // Also confirm the absence at the value level — a payload literal
    // with `messages` would be a TS error if uncommented:
    //
    //   const bad: ChatTaskWirePayload = { messages: [], chatId: "x", trigger: "submit-message" };
    //
    // Leaving as a comment for clarity; the type assertion above is the
    // load-bearing check.
  });

  it("has `message?: UIMessage` (singular, optional)", () => {
    expectTypeOf<ChatTaskWirePayload["message"]>().toEqualTypeOf<UIMessage | undefined>();
  });

  it("has `headStartMessages?: UIMessage[]` (escape hatch)", () => {
    expectTypeOf<ChatTaskWirePayload["headStartMessages"]>().toEqualTypeOf<
      UIMessage[] | undefined
    >();
  });

  it("requires `chatId: string` and `trigger: <one of>`", () => {
    expectTypeOf<ChatTaskWirePayload["chatId"]>().toEqualTypeOf<string>();
    expectTypeOf<ChatTaskWirePayload["trigger"]>().toEqualTypeOf<
      "submit-message" | "regenerate-message" | "preload" | "close" | "action" | "handover-prepare"
    >();
  });
});

describe("ChatInputChunk envelope", () => {
  it('wraps a wire payload in `kind: "message"` shape', () => {
    const userMsg: UIMessage = {
      id: "u-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    };
    const chunk: ChatInputChunk = {
      kind: "message",
      payload: {
        message: userMsg,
        chatId: "chat-1",
        trigger: "submit-message",
      },
    };

    const decoded = JSON.parse(JSON.stringify(chunk)) as ChatInputChunk;
    expect(decoded.kind).toBe("message");
    if (decoded.kind === "message") {
      expect(decoded.payload.message).toEqual(userMsg);
    }
  });

  it('supports `kind: "stop"` records (no payload)', () => {
    const chunk: ChatInputChunk = { kind: "stop", message: "user-canceled" };
    const decoded = JSON.parse(JSON.stringify(chunk)) as ChatInputChunk;
    expect(decoded.kind).toBe("stop");
    if (decoded.kind === "stop") {
      expect(decoded.message).toBe("user-canceled");
    }
  });

  it('supports `kind: "handover"` records (with partialAssistantMessage)', () => {
    const chunk: ChatInputChunk = {
      kind: "handover",
      partialAssistantMessage: [
        { role: "assistant", content: [{ type: "text", text: "partial" }] },
      ],
      messageId: "a-1",
      isFinal: false,
    };
    const decoded = JSON.parse(JSON.stringify(chunk)) as ChatInputChunk;
    expect(decoded.kind).toBe("handover");
  });

  it('supports `kind: "handover-skip"` records', () => {
    const chunk: ChatInputChunk = { kind: "handover-skip" };
    const decoded = JSON.parse(JSON.stringify(chunk)) as ChatInputChunk;
    expect(decoded.kind).toBe("handover-skip");
  });
});
