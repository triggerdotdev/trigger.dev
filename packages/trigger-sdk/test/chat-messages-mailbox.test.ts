// Import the test harness FIRST — this installs the resource catalog so
// `chat.customAgent()` calls below register their task functions correctly.
import "../src/v3/test/index.js";

import { resourceCatalog, sessionStreams } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { describe, expect, it } from "vitest";
import {
  __chatInputCheckpointForTests as chatInputCheckpoint,
  chat,
  type ChatMessageRecord,
  type ChatTaskWirePayload,
} from "../src/v3/ai.js";

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
        observations.cursorAfterFirst = chatInputCheckpoint().resumeFrom;
        observations.afterFirst = await chat.messages.hasPending();
        observations.second = await chat.messages.next();
        observations.cursorAfterSecond = chatInputCheckpoint().resumeFrom;
        observations.afterSecond = await chat.messages.hasPending();
      },
    });
    const run = resourceCatalog.getTask(agent.id)?.fns.run;
    if (!run) throw new Error("custom agent was not registered");

    await runInMockTaskContext(async (drivers) => {
      const runPromise = run(
        { chatId, trigger: "handover-prepare" },
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
        result = await chat.messages.next({ timeoutInSeconds: 0 });
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

  it("delivers a message that arrived behind another kind, without losing that kind", async () => {
    const chatId = "mailbox-mixed-kinds";
    const ready = deferred();
    const inspect = deferred();
    const observations: {
      pending?: boolean;
      message?: ChatMessageRecord;
      handover?: unknown;
      cursorAfter?: number;
    } = {};

    const agent = chat.customAgent({
      id: "chat-messages-mailbox-mixed-kinds",
      run: async () => {
        ready.resolve();
        await inspect.promise;

        observations.pending = await chat.messages.hasPending();
        observations.message = await chat.messages.next({ timeoutInSeconds: 0 });
        observations.handover = await chat.waitForHandover({
          payload: { trigger: "handover-prepare" },
          idleTimeoutInSeconds: 0,
        });
        observations.cursorAfter = chatInputCheckpoint().resumeFrom;
      },
    });
    const run = resourceCatalog.getTask(agent.id)?.fns.run;
    if (!run) throw new Error("custom agent was not registered");

    await runInMockTaskContext(async (drivers) => {
      const runPromise = run(
        { chatId, trigger: "handover-prepare" },
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

    // The handover has its own route, so it neither blocks the message behind
    // it nor gets destroyed by the consumer that took that message.
    expect(observations).toEqual({
      pending: true,
      message: {
        id: "message-1",
        seqNum: 31,
        payload: userPayload(chatId, "u-after-handover"),
      },
      handover: { kind: "handover", partialAssistantMessage: [], isFinal: false },
      cursorAfter: 31,
    });
  });

  it("holds the resume cursor behind a queued message while a later stop advances the replay window", async () => {
    const chatId = "mailbox-cursor-gap";
    const ready = deferred();
    const inspect = deferred();
    const observations: {
      cursorBefore?: number;
      appliedBefore?: number;
      message?: ChatMessageRecord;
      cursorAfter?: number;
      appliedAfter?: number;
    } = {};

    const agent = chat.customAgent({
      id: "chat-messages-mailbox-cursor-gap",
      run: async () => {
        const stop = chat.createStopSignal();
        ready.resolve();
        await inspect.promise;

        observations.cursorBefore = chatInputCheckpoint().resumeFrom;
        observations.appliedBefore = chatInputCheckpoint().appliedThrough;
        observations.message = await chat.messages.next({ timeoutInSeconds: 0 });
        observations.cursorAfter = chatInputCheckpoint().resumeFrom;
        observations.appliedAfter = chatInputCheckpoint().appliedThrough;
        stop.cleanup();
      },
    });
    const run = resourceCatalog.getTask(agent.id)?.fns.run;
    if (!run) throw new Error("custom agent was not registered");

    await runInMockTaskContext(async (drivers) => {
      const runPromise = run(
        { chatId, trigger: "handover-prepare" },
        { ctx: drivers.ctx, signal: new AbortController().signal }
      );
      await ready.promise;

      await drivers.sessions.in.send(
        chatId,
        { kind: "message", payload: userPayload(chatId, "u1") },
        "in",
        { id: "message-1", seqNum: 50 }
      );
      await drivers.sessions.in.send(chatId, { kind: "stop" }, "in", {
        id: "stop-1",
        seqNum: 51,
      });
      inspect.resolve();
      await runPromise;
    });

    expect(observations).toEqual({
      // Held below the queued message even though the stop after it was applied.
      cursorBefore: 49,
      appliedBefore: 51,
      message: {
        id: "message-1",
        seqNum: 50,
        payload: userPayload(chatId, "u1"),
      },
      cursorAfter: 51,
      appliedAfter: 51,
    });
  });

  it("keeps record id and sequence stable across redelivery", async () => {
    const payload = userPayload("mailbox-redelivery", "u-redelivered");
    const ready = deferred();
    const consumeFirst = deferred();
    const readyForRedelivery = deferred();
    const consumeRedelivery = deferred();
    let first: ChatMessageRecord | undefined;
    let redelivered: ChatMessageRecord | undefined;
    const agent = chat.customAgent({
      id: "chat-messages-mailbox-redelivery",
      run: async () => {
        ready.resolve();
        await consumeFirst.promise;
        first = await chat.messages.next({ timeoutInSeconds: 0 });

        sessionStreams.disconnectStream(payload.chatId, "in");
        readyForRedelivery.resolve();
        await consumeRedelivery.promise;
        redelivered = await chat.messages.next({ timeoutInSeconds: 0 });
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
      consumeFirst.resolve();

      await readyForRedelivery.promise;
      await drivers.sessions.in.send(payload.chatId, { kind: "message", payload }, "in", {
        id: "part-redelivered",
        seqNum: 27,
      });
      consumeRedelivery.resolve();
      await runPromise;
    });

    expect(first).toEqual({ id: "part-redelivered", seqNum: 27, payload });
    expect(redelivered).toEqual(first);
  });

  it("delivers a message queued behind a control record no consumer claimed", async () => {
    const chatId = "mailbox-unclaimed-head";
    const ready = deferred();
    const inspect = deferred();
    const observed: { pending?: boolean; message?: ChatMessageRecord } = {};

    const agent = chat.customAgent({
      id: "chat-messages-mailbox-unclaimed-head",
      run: async () => {
        ready.resolve();
        await inspect.promise;
        observed.pending = await chat.messages.hasPending();
        observed.message = await chat.messages.next({ timeoutInSeconds: 0 });
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

      await drivers.sessions.in.send(chatId, { kind: "stop" }, "in", {
        id: "unclaimed-stop",
        seqNum: 60,
      });
      await drivers.sessions.in.send(
        chatId,
        { kind: "message", payload: userPayload(chatId, "u-behind-stop") },
        "in",
        { id: "behind-stop", seqNum: 61 }
      );
      inspect.resolve();
      await runPromise;
    });

    expect(observed).toEqual({
      pending: true,
      message: {
        id: "behind-stop",
        seqNum: 61,
        payload: userPayload(chatId, "u-behind-stop"),
      },
    });
  });
});
