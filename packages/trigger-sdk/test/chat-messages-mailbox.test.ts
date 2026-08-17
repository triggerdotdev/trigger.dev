// Import the test harness FIRST — this installs the resource catalog so
// `chat.customAgent()` calls below register their task functions correctly.
import "../src/v3/test/index.js";

import { resourceCatalog, sessionStreams } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { describe, expect, it } from "vitest";
import { chat, type ChatMessageRecord, type ChatTaskWirePayload } from "../src/v3/ai.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function userPayload(chatId: string, id: string): ChatTaskWirePayload {
  return {
    chatId,
    trigger: "submit-message",
    message: {
      id,
      role: "user",
      parts: [{ type: "text", text: id }],
    },
  };
}

describe("chat.messages mailbox", () => {
  it("checks pending input without consuming and takes one buffered record at a time", async () => {
    const chatId = "mailbox-buffered";
    const ready = deferred();
    const inspect = deferred();
    const observations: {
      initial?: boolean;
      before?: boolean;
      afterFirst?: boolean;
      afterSecond?: boolean;
      first?: ChatMessageRecord;
      second?: ChatMessageRecord;
      cursorAfterFirst?: number;
      cursorAfterSecond?: number;
    } = {};

    const agent = chat.customAgent({
      id: "chat-messages-mailbox-buffered",
      run: async () => {
        observations.initial = await chat.messages.hasPending();
        ready.resolve();
        await inspect.promise;

        observations.before = await chat.messages.hasPending();
        observations.first = await chat.messages.next();
        observations.cursorAfterFirst = sessionStreams.lastDispatchedSeqNum(chatId, "in");
        observations.afterFirst = await chat.messages.hasPending();
        observations.second = await chat.messages.next();
        observations.cursorAfterSecond = sessionStreams.lastDispatchedSeqNum(chatId, "in");
        observations.afterSecond = await chat.messages.hasPending();
      },
    });
    const run = resourceCatalog.getTask(agent.id)?.fns.run;
    if (!run) throw new Error("custom agent was not registered");

    await runInMockTaskContext(async (drivers) => {
      const runPromise = run(
        { chatId, trigger: "preload" },
        { ctx: drivers.ctx, signal: new AbortController().signal }
      );
      await ready.promise;

      await drivers.sessions.in.send(
        chatId,
        { kind: "message", payload: userPayload(chatId, "u1") },
        "in",
        { id: "part-1", seqNum: 10 }
      );
      await drivers.sessions.in.send(
        chatId,
        { kind: "message", payload: userPayload(chatId, "u2") },
        "in",
        { id: "part-2", seqNum: 11 }
      );
      inspect.resolve();
      await runPromise;
    });

    expect(observations).toEqual({
      initial: false,
      before: true,
      first: { id: "part-1", seqNum: 10, payload: userPayload(chatId, "u1") },
      cursorAfterFirst: 10,
      afterFirst: true,
      second: { id: "part-2", seqNum: 11, payload: userPayload(chatId, "u2") },
      cursorAfterSecond: 11,
      afterSecond: false,
    });
  });

  it("returns undefined when next times out", async () => {
    let result: ChatMessageRecord | undefined;
    const agent = chat.customAgent({
      id: "chat-messages-mailbox-timeout",
      run: async () => {
        result = await chat.messages.next({ timeoutInSeconds: 0.01 });
      },
    });
    const run = resourceCatalog.getTask(agent.id)?.fns.run;
    if (!run) throw new Error("custom agent was not registered");

    await runInMockTaskContext((drivers) =>
      run(
        { chatId: "mailbox-timeout", trigger: "preload" },
        { ctx: drivers.ctx, signal: new AbortController().signal }
      )
    );

    expect(result).toBeUndefined();
  });

  it("leaves earlier non-message records for their own consumer", async () => {
    const chatId = "mailbox-mixed-kinds";
    const ready = deferred();
    const inspect = deferred();
    const observations: {
      pending?: boolean;
      blocked?: ChatMessageRecord;
      cursorAfterBlocked?: number;
      headAfterBlocked?: unknown;
      control?: unknown;
      message?: ChatMessageRecord;
      cursorAfterMessage?: number;
    } = {};

    const agent = chat.customAgent({
      id: "chat-messages-mailbox-mixed-kinds",
      run: async () => {
        ready.resolve();
        await inspect.promise;

        observations.pending = await chat.messages.hasPending();
        observations.blocked = await chat.messages.next({ timeoutInSeconds: 0.01 });
        observations.cursorAfterBlocked = sessionStreams.lastDispatchedSeqNum(chatId, "in");
        observations.headAfterBlocked = sessionStreams.peekRecord(chatId, "in");

        const control = await sessionStreams.onceRecord(chatId, "in");
        observations.control = control.ok ? control.output : undefined;
        observations.message = await chat.messages.next({ timeoutInSeconds: 0 });
        observations.cursorAfterMessage = sessionStreams.lastDispatchedSeqNum(chatId, "in");
      },
    });
    const run = resourceCatalog.getTask(agent.id)?.fns.run;
    if (!run) throw new Error("custom agent was not registered");

    await runInMockTaskContext(async (drivers) => {
      const runPromise = run(
        { chatId, trigger: "preload" },
        { ctx: drivers.ctx, signal: new AbortController().signal }
      );
      await ready.promise;

      await drivers.sessions.in.send(
        chatId,
        { kind: "handover", partialAssistantMessage: [], isFinal: false },
        "in",
        { id: "handover-1", seqNum: 30 }
      );
      await drivers.sessions.in.send(
        chatId,
        { kind: "message", payload: userPayload(chatId, "u-after-handover") },
        "in",
        { id: "message-1", seqNum: 31 }
      );
      inspect.resolve();
      await runPromise;
    });

    expect(observations).toEqual({
      pending: true,
      blocked: undefined,
      cursorAfterBlocked: undefined,
      headAfterBlocked: {
        id: "handover-1",
        seqNum: 30,
        data: { kind: "handover", partialAssistantMessage: [], isFinal: false },
      },
      control: {
        id: "handover-1",
        seqNum: 30,
        data: { kind: "handover", partialAssistantMessage: [], isFinal: false },
      },
      message: {
        id: "message-1",
        seqNum: 31,
        payload: userPayload(chatId, "u-after-handover"),
      },
      cursorAfterMessage: 31,
    });
  });

  it("keeps record id and sequence stable across redelivery", async () => {
    const payload = userPayload("mailbox-redelivery", "u-redelivered");

    async function consumeDelivery(agentId: string): Promise<ChatMessageRecord | undefined> {
      const ready = deferred();
      const consume = deferred();
      let result: ChatMessageRecord | undefined;
      const agent = chat.customAgent({
        id: agentId,
        run: async () => {
          ready.resolve();
          await consume.promise;
          result = await chat.messages.next();
        },
      });
      const run = resourceCatalog.getTask(agent.id)?.fns.run;
      if (!run) throw new Error("custom agent was not registered");

      await runInMockTaskContext(async (drivers) => {
        const runPromise = run(
          { chatId: payload.chatId, trigger: "preload" },
          { ctx: drivers.ctx, signal: new AbortController().signal }
        );
        await ready.promise;
        await drivers.sessions.in.send(payload.chatId, { kind: "message", payload }, "in", {
          id: "part-redelivered",
          seqNum: 27,
        });
        consume.resolve();
        await runPromise;
      });

      return result;
    }

    const first = await consumeDelivery("chat-messages-mailbox-first-delivery");
    const redelivered = await consumeDelivery("chat-messages-mailbox-redelivery");

    expect(first).toEqual({ id: "part-redelivered", seqNum: 27, payload });
    expect(redelivered).toEqual(first);
  });
});
