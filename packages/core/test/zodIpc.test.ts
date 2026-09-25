import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { ZodIpcConnection } from "../src/v3/zodIpc.js";

// A pair of in-memory endpoints that serialize packets the same way Node's default
// ("json") IPC serialization does, so keys with `undefined` values are dropped in transit.
function createIpcPair() {
  const parentEvents = new EventEmitter();
  const childEvents = new EventEmitter();

  const endpoint = (inbox: EventEmitter, outbox: EventEmitter) => ({
    connected: true,
    send: (message: unknown) => {
      const serialized = JSON.stringify(message);
      setImmediate(() => outbox.emit("message", JSON.parse(serialized)));
      return true;
    },
    on: (event: "message", listener: (message: any) => void) => {
      inbox.on(event, listener);
    },
  });

  return {
    parent: endpoint(parentEvents, childEvents),
    child: endpoint(childEvents, parentEvents),
  };
}

const ParentToChild = {
  FLUSH: {
    message: z.object({ timeoutInMs: z.number() }),
    callback: z.void(),
  },
  PING: {
    message: z.object({ value: z.string() }),
    callback: z.object({ echoed: z.string() }),
  },
};

const ChildToParent = {};

function createConnections() {
  const { parent, child } = createIpcPair();

  const parentConnection = new ZodIpcConnection({
    listenSchema: ChildToParent,
    emitSchema: ParentToChild,
    process: parent,
  });

  new ZodIpcConnection({
    listenSchema: ParentToChild,
    emitSchema: ChildToParent,
    process: child,
    handlers: {
      FLUSH: async () => {},
      PING: async ({ value }) => ({ echoed: value }),
    },
  });

  return parentConnection;
}

describe("ZodIpcConnection", () => {
  it("resolves sendWithAck for a void callback after the ack crosses a JSON boundary", async () => {
    const connection = createConnections();

    await expect(connection.sendWithAck("FLUSH", { timeoutInMs: 1000 }, 1000)).resolves.toBe(
      undefined
    );
  });

  it("resolves sendWithAck with the callback payload", async () => {
    const connection = createConnections();

    await expect(connection.sendWithAck("PING", { value: "hello" }, 1000)).resolves.toEqual({
      echoed: "hello",
    });
  });
});
