import {
  convertToModelMessages,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
  type ModelMessage,
} from "ai";
import { describe, it, expect } from "vitest";
import { ManagedChatResponse, createOrderedChatWriter } from "./managedChatResponse.js";
import {
  convertSteeredMessages,
  retainStepMessages,
  type SteeringInjection,
} from "./steeringContext.js";
import {
  normalizeRuntimeStateForWindow,
  parseTranscriptRuntimeState,
  restoreModelLane,
} from "./transcriptStorage.js";
import { responseAfterCompaction } from "./compactionResponse.js";

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
const modelUser = (content: string): ModelMessage => ({ role: "user", content });
const marker: UIMessageChunk = {
  type: "data-pending-message-injected",
  id: "injection-1",
  data: { messageIds: ["steer"], messages: [{ id: "steer", text: "Only Platform" }] },
};
const firstStep: UIMessageChunk[] = [
  { type: "start", messageId: "answer" },
  { type: "start-step" },
  { type: "tool-input-available", toolCallId: "lookup-1", toolName: "lookup", input: {} },
  {
    type: "tool-output-available",
    toolCallId: "lookup-1",
    output: { projects: ["Platform", "Website"] },
  },
  { type: "finish-step" },
];
const lastStep: UIMessageChunk[] = [
  { type: "start-step" },
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: "Platform is ready." },
  { type: "text-end", id: "text" },
  { type: "finish-step" },
  { type: "finish" },
];
function source(chunks: UIMessageChunk[]) {
  return new ReadableStream<UIMessageChunk>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}
function response() {
  const emitted: UIMessageChunk[] = [];
  const capture = new ManagedChatResponse(async (stream) => {
    for await (const chunk of stream) emitted.push(chunk);
  });
  return { capture, emitted };
}
async function reduce(chunks: UIMessageChunk[], message?: UIMessage) {
  let result: UIMessage | undefined;
  for await (const update of readUIMessageStream({ stream: source(chunks), message }))
    result = update;
  return result;
}
const convert = async (messages: UIMessage[]) =>
  convertToModelMessages(messages, { ignoreIncompleteToolCalls: true });

describe("ordered managed response", () => {
  it("matches the browser and persistence, even when prepareStep outruns the UI consumer", async () => {
    const { capture, emitted } = response();
    capture.afterStep(1);
    capture.writeData(marker);
    capture.writeData({ type: "data-position", id: "custom", data: "between steps" });
    await capture.pipe(source([...firstStep, ...lastStep]));
    const saved = await capture.snapshot();
    await capture.close();
    expect(await reduce(emitted)).toEqual(saved);
    expect(saved?.parts.map((p) => p.type)).toEqual([
      "step-start",
      "tool-lookup",
      "data-pending-message-injected",
      "data-position",
      "step-start",
      "text",
    ]);
    expect(emitted.indexOf(marker)).toBe(emitted.findIndex((c) => c.type === "finish-step") + 1);
  });

  it.each(["end", "error", "abort", "close"])(
    "preserves boundary-gated data when the source terminates early: %s",
    async (termination) => {
      const { capture, emitted } = response();
      const custom: UIMessageChunk = { type: "data-position", data: "accepted" };
      capture.afterStep(1);
      capture.writeData(marker);
      capture.writeData(custom);
      if (termination === "close") {
        await capture.close();
      } else {
        const abort = new AbortController();
        let next = 0;
        const early = new ReadableStream<UIMessageChunk>({
          pull(controller) {
            if (next < firstStep.length - 1) controller.enqueue(firstStep[next++]!);
            else if (termination === "error") controller.error(new Error("early failure"));
            else if (termination === "abort") abort.abort(new Error("stopped"));
            else controller.close();
          },
        });
        const work = capture.pipe(early, abort.signal);
        if (termination === "error") await expect(work).rejects.toThrow("early failure");
        else if (termination === "abort") await work.catch(() => {});
        else await work;
      }
      // SDK callers snapshot before closing the response on source termination.
      const saved = await capture.snapshot();
      await capture.close();
      expect(saved?.parts.slice(-2)).toEqual([
        { type: marker.type, id: "injection-1", data: marker.data },
        { type: custom.type, data: "accepted" },
      ]);
      expect(emitted.filter((chunk) => chunk === marker || chunk === custom)).toEqual([
        marker,
        custom,
      ]);
      expect(await reduce(emitted)).toEqual(saved);
    }
  );

  it("aborts a pending async iterator without waiting for its cleanup", async () => {
    const { capture } = response();
    const abort = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let returned = false;
    const blocked: AsyncIterable<UIMessageChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            started();
            return new Promise<IteratorResult<UIMessageChunk>>(() => {});
          },
          return() {
            returned = true;
            return new Promise<IteratorResult<UIMessageChunk>>(() => {});
          },
        };
      },
    };
    const work = capture.pipe(blocked, abort.signal);
    await waiting;
    const reason = new Error("stop requested");
    abort.abort(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        work.then(
          () => "completed",
          (error) => error
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("still blocked"), 200);
        }),
      ]);
      expect(outcome).toBe(reason);
      expect(returned).toBe(true);
    } finally {
      clearTimeout(timer);
      await capture.close();
    }
  });

  it.each([true, false])("preserves mixed hook-stream order (managed turn: %s)", async (active) => {
    const emitted: UIMessageChunk[] = [];
    let publishers = 0;
    const publish = async (stream: ReadableStream<UIMessageChunk>) => {
      publishers++;
      // Different publishers would be able to overtake this asynchronous reader.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      for await (const chunk of stream) emitted.push(chunk);
    };
    const capture = new ManagedChatResponse(publish);
    const { writer, flush } = createOrderedChatWriter(
      () => (active ? capture : undefined),
      publish
    );
    const mixed: UIMessageChunk[] = [
      { type: "data-status", id: "status", data: "loading" },
      { type: "start-step" },
      { type: "data-note", data: "before text" },
      { type: "text-start", id: "hook-text" },
      { type: "text-delta", id: "hook-text", delta: "stream only" },
      { type: "data-status", id: "status", data: "done" },
      { type: "text-end", id: "hook-text" },
      { type: "finish-step" },
      { type: "data-progress", transient: true, data: "transient" },
    ];
    if (active) capture.afterStep(1);
    writer.merge(source(mixed));
    await flush();
    if (active) await capture.pipe(source(firstStep));
    await capture.close();
    expect(publishers).toBe(1);
    expect(emitted).toEqual(active ? [...firstStep, ...mixed] : mixed);
    const saved = await capture.snapshot();
    if (active) {
      expect(saved?.parts.filter((part) => part.type.startsWith("data-"))).toEqual([
        { type: "data-status", id: "status", data: "done" },
        { type: "data-note", data: "before text" },
      ]);
      expect(saved?.parts.some((part) => part.type === "text")).toBe(false);
    } else expect(saved).toBeUndefined();
  });

  it("orders injection against the current generation after an earlier generation finished", async () => {
    const { capture, emitted } = response();
    await capture.pipe(source([...firstStep, ...lastStep]));
    capture.beginGeneration();
    capture.afterStep(1);
    capture.writeData(marker);
    const second = firstStep.slice(1);
    await capture.pipe(source(second));
    await capture.close();
    expect(emitted.indexOf(marker)).toBe(emitted.map((c) => c.type).lastIndexOf("finish-step") + 1);
  });

  it("keeps raw-pipe injection events observable without capturing raw model output", async () => {
    const { capture, emitted } = response();
    capture.afterStep(1);
    capture.writeData(marker);
    capture.useRawPipe();
    capture.afterStep(2);
    const custom: UIMessageChunk = { type: "data-position", data: "raw owner" };
    capture.writeData(custom);
    await capture.close();
    expect(emitted.slice(0, 2)).toEqual([marker, custom]);
    expect((await capture.snapshot())?.parts.map((p) => p.type)).toEqual([
      "data-pending-message-injected",
      "data-position",
    ]);
  });

  it("gives a data-only response the same stable ID live and in storage", async () => {
    const { capture, emitted } = response();
    capture.writeData({ type: "data-card", data: "No model needed" });
    const saved = await capture.snapshot();
    await capture.close();
    expect(saved?.id).toBeTruthy();
    expect(await reduce(emitted)).toEqual(saved);
  });

  it("applies late writes to an explicitly edited response without undoing the edit", async () => {
    const { capture } = response();
    await capture.pipe(source([...firstStep, ...lastStep]));
    const saved = (await capture.snapshot())!;
    const revision = capture.revision;
    const edited: UIMessage = {
      ...saved,
      parts: [{ type: "text", text: "Application edited this" }],
    };
    capture.writeData({ type: "data-note", data: "late" });
    expect((await capture.snapshot({ message: edited, from: revision }))?.parts).toEqual([
      { type: "text", text: "Application edited this" },
      { type: "data-note", data: "late" },
    ]);
    await capture.close();
  });

  it("updates existing IDs in place across early and late hook writes and excludes transient data", async () => {
    const { capture, emitted } = response();
    capture.writeData({ type: "data-status", id: "status", data: "loading" });
    await capture.pipe(source([...firstStep, ...lastStep]));
    capture.writeData({ type: "data-status", id: "status", data: "done" });
    capture.writeData({ type: "data-progress", transient: true, data: "ephemeral" });
    const saved = await capture.snapshot();
    await capture.close();
    expect(saved).toEqual(await reduce(emitted));
    expect(saved?.parts[0]).toMatchObject({ type: "data-status", data: "done" });
    expect(saved?.parts.filter((p) => p.type === "data-status")).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain("ephemeral");
  });

  it("seeds same-ID continuations without mutating the original assistant", async () => {
    const original = (await reduce(firstStep))!;
    const before = structuredClone(original);
    const { capture, emitted } = response();
    capture.seed([original]);
    capture.writeData(marker);
    await capture.pipe(source([{ type: "start", messageId: original.id }, ...lastStep]));
    const saved = await capture.snapshot();
    await capture.close();
    expect(original).toEqual(before);
    expect(saved).toEqual(await reduce(emitted, structuredClone(original)));
    expect(saved?.parts.map((p) => p.type)).toEqual([
      "step-start",
      "tool-lookup",
      "data-pending-message-injected",
      "step-start",
      "text",
    ]);
  });

  it("recovers already emitted data and text when the source errors", async () => {
    const { capture, emitted } = response();
    await capture.pipe(source(firstStep));
    capture.writeData(marker);
    const chunks = lastStep.slice(0, 3);
    const broken = new ReadableStream<UIMessageChunk>({
      pull(c) {
        const chunk = chunks.shift();
        if (chunk) c.enqueue(chunk);
        else c.error(new Error("source failed"));
      },
    });
    await expect(capture.pipe(broken)).rejects.toThrow("source failed");
    const saved = await capture.snapshot();
    await capture.close();
    expect(saved).toEqual(await reduce(emitted));
    expect(saved?.parts.at(-1)).toMatchObject({ type: "text", text: "Platform is ready." });
  });
});

describe("steering model context", () => {
  const prepared: SteeringInjection = {
    id: "injection-1",
    messageIds: ["steer"],
    messages: [{ role: "system", content: "PRIVATE transformed steering" }],
  };
  const forms = new Map([[prepared.id, prepared]]);

  it("preserves overrides over later steps on both resetting and retaining AI SDK versions", async () => {
    for (const sdkRetains of [false, true]) {
      const first = modelUser("original");
      const steer = modelUser("steer");
      const outputs: ModelMessage[] = [
        { role: "assistant", content: "step one" },
        { role: "assistant", content: "step two" },
      ];
      const prepare = retainStepMessages(async ({ messages, steps }) =>
        steps.length === 1 ? { messages: [...messages, steer] } : undefined
      );
      expect(await prepare({ messages: [first], steps: [] })).toBeUndefined();
      const second = await prepare({
        messages: [first, outputs[0]!],
        steps: [{ response: { messages: outputs.slice(0, 1) } }],
      });
      expect(second?.messages).toEqual([first, outputs[0], steer]);
      const third = await prepare({
        messages: sdkRetains ? [...second!.messages!, outputs[1]!] : [first, ...outputs],
        steps: outputs.map((_, i) => ({ response: { messages: outputs.slice(0, i + 1) } })),
      });
      expect(third?.messages).toEqual([first, outputs[0], steer, outputs[1]]);
      expect(
        await prepare({ messages: [modelUser("fresh generation")], steps: [] })
      ).toBeUndefined();
    }
  });

  it("retains compaction instead of reintroducing old response segments", async () => {
    const summary = modelUser("summary");
    const old = modelUser("old");
    const next = modelUser("new output");
    const prepare = retainStepMessages(async ({ steps }) =>
      steps.length === 1 ? { messages: [summary] } : undefined
    );
    await prepare({ messages: [old], steps: [{ response: { messages: [old] } }] });
    expect(
      (
        await prepare({
          messages: [old, next],
          steps: [{ response: { messages: [old] } }, { response: { messages: [old, next] } }],
        })
      )?.messages
    ).toEqual([summary, next]);
  });

  it("keeps complete tool pairs before transformed steering and restores that order in a fresh worker", async () => {
    const answer = (await reduce([...firstStep, marker, ...lastStep]))!;
    const ui = [user("original", "all projects"), user("steer", "Only Platform"), answer];
    const state = parseTranscriptRuntimeState(
      JSON.parse(JSON.stringify({ v: 1, steering: [prepared] }))
    )!;
    const restoredForms = new Map(state.steering!.map((entry) => [entry.id, entry]));
    const projection = (messages: UIMessage[]) =>
      convertSteeredMessages(messages, convert, restoredForms, ui);
    const model = await projection(ui);
    expect(model.map((m) => m.role)).toEqual(["user", "assistant", "tool", "system", "assistant"]);
    expect(model[3]).toEqual(prepared.messages[0]);
    expect(JSON.stringify(model)).not.toContain("Only Platform");
    expect((await restoreModelLane(ui, state, projection)).messages).toEqual(model);
    expect(JSON.stringify(answer)).not.toContain("PRIVATE");
  });

  it.each([false, true])(
    "keeps tools, steering and answers across two later turns (reload runtime state: %s)",
    async (restart) => {
      const secondTool: UIMessageChunk[] = firstStep
        .slice(1)
        .map((chunk) => ("toolCallId" in chunk ? { ...chunk, toolCallId: "lookup-2" } : chunk));
      const firstAnswer = (await reduce([...firstStep, marker, ...secondTool, ...lastStep]))!;
      let history = [user("original", "all projects"), user("steer", "Only Platform"), firstAnswer];
      const originalAnswer = structuredClone(firstAnswer);
      let runtime = { v: 1 as const, steering: [prepared] };
      let model = await convertSteeredMessages(history, convert, forms, history, true);
      expect(model.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "system",
        "assistant",
        "tool",
        "assistant",
      ]);
      const initialModel = structuredClone(model);
      for (let turn = 1; turn <= 2; turn++) {
        const incoming = user(`followup-${turn}`, `Follow-up ${turn}: keep the same scope`);
        history.push(incoming);
        const expectedInput = [...model, ...(await convert([incoming]))];
        if (restart) {
          // Exercise the actual persisted state parser and model-lane restore,
          // with fresh objects so in-memory references cannot hide state loss.
          const saved = JSON.parse(JSON.stringify({ messages: history, state: runtime }));
          history = saved.messages;
          runtime = parseTranscriptRuntimeState(saved.state) as typeof runtime;
        }
        const currentForms = new Map(runtime.steering.map((entry) => [entry.id, entry]));
        const project = (messages: UIMessage[]) =>
          convertSteeredMessages(messages, convert, currentForms, history, true);
        const restored = await restoreModelLane(history, runtime, project);
        expect(restored.messages).toEqual(expectedInput);
        expect(restored.messages.slice(0, initialModel.length)).toEqual(initialModel);
        const followupTool: UIMessageChunk[] = firstStep.map((chunk) => {
          if (chunk.type === "start") return { ...chunk, messageId: `answer-${turn}` };
          return "toolCallId" in chunk
            ? { ...chunk, toolCallId: `followup-lookup-${turn}` }
            : chunk;
        });
        const answer = (await reduce([...followupTool, ...lastStep]))!;
        history.push(answer);
        model = [...expectedInput, ...(await convert([answer]))];
        expect(await project(history)).toEqual(model);
        expect(history.find((message) => message.id === originalAnswer.id)).toEqual(originalAnswer);
        expect(new Set(history.map((message) => message.id)).size).toBe(history.length);
        expect(model.filter((message) => message.role === "system")).toEqual(prepared.messages);
        expect(JSON.stringify(history)).not.toContain("PRIVATE");
      }
    }
  );

  it("can reconstruct ordinary steering from UI alone without duplicating its user message", async () => {
    const answer = (await reduce([...firstStep, marker, ...lastStep]))!;
    const model = await convertSteeredMessages(
      [user("steer", "Only Platform"), answer],
      convert,
      new Map()
    );
    expect(model.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant"]);
    expect(JSON.stringify(model).match(/Only Platform/g)).toHaveLength(1);
  });

  it("does not lose an injection immediately after inner compaction", async () => {
    const answer = (await reduce([...firstStep, marker, ...lastStep]))!;
    const suffix = responseAfterCompaction(answer, 1);
    const model = await convertSteeredMessages([suffix], convert, forms);
    expect(model.map((m) => m.role)).toEqual(["system", "assistant"]);
    expect(JSON.stringify(model)).not.toContain("Website");
  });

  it("retains private steering across a trimmed input and subsequent worker restart", async () => {
    const answer = (await reduce([...firstStep, marker, ...lastStep]))!;
    const history = [answer];
    const runtime = normalizeRuntimeStateForWindow({ v: 1, steering: [prepared] }, history, [
      "steer",
      answer.id,
    ]);
    const restored = parseTranscriptRuntimeState(JSON.parse(JSON.stringify(runtime)))!;
    expect(restored.steering).toHaveLength(1);
    const retainedForms = new Map(restored.steering!.map((entry) => [entry.id, entry]));
    const project = (messages: UIMessage[]) =>
      convertSteeredMessages(messages, convert, retainedForms, history, true);
    const expected = await convertSteeredMessages([answer], convert, forms);
    expect((await restoreModelLane(history, restored, project)).messages).toEqual(expected);
    const resaved = parseTranscriptRuntimeState(
      JSON.parse(
        JSON.stringify(
          normalizeRuntimeStateForWindow(
            restored,
            history,
            history.map((m) => m.id)
          )
        )
      )
    )!;
    expect(resaved.steering).toEqual(restored.steering);
    history.push(user("next", "Follow-up"));
    expect((await restoreModelLane(history, restored, project)).messages).toEqual([
      ...expected,
      ...(await convert([history[1]!])),
    ]);
    expect(JSON.stringify(history)).not.toContain("PRIVATE");
    const pruned = parseTranscriptRuntimeState(
      normalizeRuntimeStateForWindow(
        restored,
        [history[1]!],
        history.map((m) => m.id)
      )
    )!;
    expect(pruned.steering).toEqual([]);
  });

  it("honors an explicit deletion even when the saved marker retains fallback text", async () => {
    const answer = (await reduce([...firstStep, marker, ...lastStep]))!;
    const history = [user("original", "question"), answer];
    const state = parseTranscriptRuntimeState(
      JSON.parse(
        JSON.stringify(
          normalizeRuntimeStateForWindow(
            { v: 1, steering: [prepared] },
            history,
            history.map((m) => m.id)
          )
        )
      )
    )!;
    const savedForms = new Map(state.steering!.map((entry) => [entry.id, entry]));
    const model = await convertSteeredMessages(history, convert, savedForms, history, true);
    expect(JSON.stringify(model)).not.toContain("PRIVATE");
    expect(JSON.stringify(model)).not.toContain("Only Platform");
  });

  it("retains a claimed instruction if stopping leaves no captured injection marker", async () => {
    const model = await convertSteeredMessages([user("steer", "Only Platform")], convert, forms);
    expect(model).toEqual(prepared.messages);
  });
});
