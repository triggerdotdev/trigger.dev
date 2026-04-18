import { describe, expect, it } from "vitest";
import { runInMockTaskContext } from "../src/v3/test/index.js";
import { inputStreams } from "../src/v3/input-streams-api.js";
import { realtimeStreams } from "../src/v3/realtime-streams-api.js";
import { locals } from "../src/v3/locals-api.js";
import { taskContext } from "../src/v3/task-context-api.js";

describe("runInMockTaskContext", () => {
  it("installs a mock TaskRunContext with sensible defaults", async () => {
    await runInMockTaskContext(async ({ ctx }) => {
      expect(taskContext.ctx).toBeDefined();
      expect(taskContext.ctx?.run.id).toBe("run_test");
      expect(taskContext.ctx?.task.id).toBe("test-task");
      expect(ctx.run.id).toBe("run_test");
    });
  });

  it("applies ctx overrides on top of defaults", async () => {
    await runInMockTaskContext(
      async ({ ctx }) => {
        expect(ctx.run.id).toBe("run_abc");
        expect(ctx.task.id).toBe("my-chat-agent");
        // Unspecified fields still use defaults
        expect(ctx.queue.id).toBe("test-queue-id");
      },
      {
        ctx: {
          run: { id: "run_abc" },
          task: { id: "my-chat-agent", filePath: "chat.ts" },
        },
      }
    );
  });

  it("isolates locals from the surrounding context", async () => {
    const key = locals.create<{ count: number }>("test.counter");

    await runInMockTaskContext(async ({ locals: inspect }) => {
      expect(inspect.get(key)).toBeUndefined();
      locals.set(key, { count: 1 });
      expect(inspect.get(key)).toEqual({ count: 1 });
    });

    // After the harness exits, the locals should be gone
    expect(locals.get(key)).toBeUndefined();
  });

  it("tears down the task context after fn returns", async () => {
    await runInMockTaskContext(async () => {
      expect(taskContext.ctx).toBeDefined();
    });

    expect(taskContext.ctx).toBeUndefined();
  });

  it("tears down even when fn throws", async () => {
    await expect(
      runInMockTaskContext(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(taskContext.ctx).toBeUndefined();
  });

  it("returns the value returned by fn", async () => {
    const result = await runInMockTaskContext(async () => "hello");
    expect(result).toBe("hello");
  });

  describe("input streams driver", () => {
    it("resolves inputStreams.once() when test sends data", async () => {
      await runInMockTaskContext(async ({ inputs }) => {
        const pending = inputStreams.once("chat-messages");
        setTimeout(() => inputs.send("chat-messages", { hello: "world" }), 0);
        const result = await pending;
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.output).toEqual({ hello: "world" });
        }
      });
    });

    it("fires inputStreams.on() handlers when test sends data", async () => {
      await runInMockTaskContext(async ({ inputs }) => {
        const received: unknown[] = [];
        inputStreams.on("chat-messages", (data) => {
          received.push(data);
        });

        await inputs.send("chat-messages", { n: 1 });
        await inputs.send("chat-messages", { n: 2 });

        expect(received).toEqual([{ n: 1 }, { n: 2 }]);
      });
    });

    it("fires multiple on() handlers on the same stream", async () => {
      await runInMockTaskContext(async ({ inputs }) => {
        const a: unknown[] = [];
        const b: unknown[] = [];
        inputStreams.on("chat-messages", (data) => a.push(data));
        inputStreams.on("chat-messages", (data) => b.push(data));

        await inputs.send("chat-messages", "hi");
        expect(a).toEqual(["hi"]);
        expect(b).toEqual(["hi"]);
      });
    });

    it("off() unsubscribes a handler", async () => {
      await runInMockTaskContext(async ({ inputs }) => {
        const received: unknown[] = [];
        const sub = inputStreams.on("chat-messages", (data) => received.push(data));

        await inputs.send("chat-messages", 1);
        sub.off();
        await inputs.send("chat-messages", 2);

        expect(received).toEqual([1]);
      });
    });

    it("times out once() after timeoutMs", async () => {
      await runInMockTaskContext(async () => {
        const result = await inputStreams.once("chat-messages", { timeoutMs: 10 });
        expect(result.ok).toBe(false);
      });
    });

    it("peek() returns the latest sent value", async () => {
      await runInMockTaskContext(async ({ inputs }) => {
        expect(inputStreams.peek("chat-messages")).toBeUndefined();
        await inputs.send("chat-messages", { latest: true });
        expect(inputStreams.peek("chat-messages")).toEqual({ latest: true });
      });
    });

    it("close() rejects pending once() waiters with a timeout error", async () => {
      await runInMockTaskContext(async ({ inputs }) => {
        const pending = inputStreams.once("chat-messages");
        inputs.close("chat-messages");
        const result = await pending;
        expect(result.ok).toBe(false);
      });
    });

    it("resolves multiple concurrent once() waiters from a single send", async () => {
      await runInMockTaskContext(async ({ inputs }) => {
        const a = inputStreams.once("chat-messages");
        const b = inputStreams.once("chat-messages");
        await inputs.send("chat-messages", "shared");
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra.ok && ra.output).toBe("shared");
        expect(rb.ok && rb.output).toBe("shared");
      });
    });
  });

  describe("realtime streams driver", () => {
    it("collects chunks from realtimeStreams.append()", async () => {
      await runInMockTaskContext(async ({ outputs }) => {
        await realtimeStreams.append("chat", "chunk-1" as unknown as BodyInit);
        await realtimeStreams.append("chat", "chunk-2" as unknown as BodyInit);

        expect(outputs.chunks("chat")).toEqual(["chunk-1", "chunk-2"]);
      });
    });

    it("collects chunks from realtimeStreams.pipe()", async () => {
      await runInMockTaskContext(async ({ outputs }) => {
        const source = (async function* () {
          yield "a";
          yield "b";
          yield "c";
        })();

        const instance = realtimeStreams.pipe("chat", source);

        // Drain the returned stream — that's what feeds the buffer
        for await (const _ of instance.stream) {
          // no-op
        }

        expect(outputs.chunks("chat")).toEqual(["a", "b", "c"]);
      });
    });

    it("separates chunks by stream id", async () => {
      await runInMockTaskContext(async ({ outputs }) => {
        await realtimeStreams.append("chat", "a" as unknown as BodyInit);
        await realtimeStreams.append("stop", "halt" as unknown as BodyInit);

        expect(outputs.chunks("chat")).toEqual(["a"]);
        expect(outputs.chunks("stop")).toEqual(["halt"]);
        expect(outputs.all()).toEqual({ chat: ["a"], stop: ["halt"] });
      });
    });

    it("clear() empties one stream or all streams", async () => {
      await runInMockTaskContext(async ({ outputs }) => {
        await realtimeStreams.append("chat", "a" as unknown as BodyInit);
        await realtimeStreams.append("stop", "halt" as unknown as BodyInit);

        outputs.clear("chat");
        expect(outputs.chunks("chat")).toEqual([]);
        expect(outputs.chunks("stop")).toEqual(["halt"]);

        outputs.clear();
        expect(outputs.chunks("stop")).toEqual([]);
      });
    });
  });

  it("tears down input/output managers so consecutive calls are isolated", async () => {
    await runInMockTaskContext(async ({ inputs }) => {
      await inputs.send("chat-messages", "first-run");
    });

    await runInMockTaskContext(async ({ outputs }) => {
      expect(outputs.chunks("chat-messages")).toEqual([]);
      // inputs.peek should NOT see "first-run" from the prior harness
      expect(inputStreams.peek("chat-messages")).toBeUndefined();
    });
  });
});
