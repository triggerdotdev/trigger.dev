import { describe, it, expect } from "vitest";
import { ZodNamespace } from "../src/v3/zodNamespace.js";
import type { Server } from "socket.io";
import { z } from "zod";

const createStubServer = (): Server => {
  const namespace = {
    use: () => namespace,
    on: () => namespace,
    emit: () => {},
    fetchSockets: async () => [],
  } as any;
  return { of: () => namespace } as any;
};

describe("ZodNamespace", () => {
  it("throws when serverMessages include callbacks", () => {
    const io = createStubServer();

    const clientMessages = {} as const;
    const serverMessages = {
      TEST: {
        message: z.object({ version: z.literal("v1").default("v1") }),
        callback: z.void(),
      },
    } as const;

    expect(
      () =>
        new ZodNamespace({
          io,
          name: "test",
          clientMessages,
          serverMessages,
        })
    ).toThrowError(/callbacks are not supported/);
  });
});
