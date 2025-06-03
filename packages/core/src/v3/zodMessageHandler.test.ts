import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ZodMessageHandler } from "./zodMessageHandler.js";
import { z } from "zod";

describe("ZodMessageHandler.registerHandlers", () => {
  const schema = { TEST: z.object({ foo: z.string() }) } as const;

  it("handles messages with an explicit payload field", async () => {
    const handler = vi.fn(async (payload: { foo: string }) => payload);
    const messageHandler = new ZodMessageHandler({ schema, messages: { TEST: handler } });
    const emitter = new EventEmitter();
    messageHandler.registerHandlers(emitter);

    const ack = await new Promise((resolve) => {
      emitter.emit("TEST", { payload: { foo: "bar" }, version: "v1" }, resolve);
    });

    expect(handler).toHaveBeenCalledWith({ foo: "bar" });
    expect(ack).toEqual({ foo: "bar" });
  });

  it("handles messages without a payload field", async () => {
    const handler = vi.fn(async (payload: { foo: string }) => payload);
    const messageHandler = new ZodMessageHandler({ schema, messages: { TEST: handler } });
    const emitter = new EventEmitter();
    messageHandler.registerHandlers(emitter);

    const ack = await new Promise((resolve) => {
      emitter.emit("TEST", { foo: "baz", version: "v1" }, resolve);
    });

    expect(handler).toHaveBeenCalledWith({ foo: "baz" });
    expect(ack).toEqual({ foo: "baz" });
  });
});
