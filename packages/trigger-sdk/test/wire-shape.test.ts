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

describe("ChatTaskWirePayload (compile-time shape)", () => {
  it("does NOT have a `messages` array field (slim wire removed it)", () => {
    // If a future edit reintroduces `messages: TMessage[]`, this assertion
    // forces a compile error rather than letting the wire silently grow
    // back.
    type WirePayloadKeys = keyof ChatTaskWirePayload;
    expectTypeOf<WirePayloadKeys>().not.toEqualTypeOf<"messages" | Exclude<WirePayloadKeys, "messages">>();
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
      | "submit-message"
      | "regenerate-message"
      | "preload"
      | "close"
      | "action"
      | "handover-prepare"
    >();
  });
});

describe("ChatInputChunk envelope", () => {
  it("wraps a wire payload in `kind: \"message\"` shape", () => {
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

  it("supports `kind: \"stop\"` records (no payload)", () => {
    const chunk: ChatInputChunk = { kind: "stop", message: "user-canceled" };
    const decoded = JSON.parse(JSON.stringify(chunk)) as ChatInputChunk;
    expect(decoded.kind).toBe("stop");
    if (decoded.kind === "stop") {
      expect(decoded.message).toBe("user-canceled");
    }
  });

  it("supports `kind: \"handover\"` records (with partialAssistantMessage)", () => {
    const chunk: ChatInputChunk = {
      kind: "handover",
      partialAssistantMessage: [{ type: "text", text: "partial" }],
      messageId: "a-1",
      isFinal: false,
    };
    const decoded = JSON.parse(JSON.stringify(chunk)) as ChatInputChunk;
    expect(decoded.kind).toBe("handover");
  });

  it("supports `kind: \"handover-skip\"` records", () => {
    const chunk: ChatInputChunk = { kind: "handover-skip" };
    const decoded = JSON.parse(JSON.stringify(chunk)) as ChatInputChunk;
    expect(decoded.kind).toBe("handover-skip");
  });
});
