import { describe, it, expect, vi } from "vitest";
import { ZodNamespace } from "../../src/v3/zodNamespace.js";
import { z } from "zod";
import { Server } from "socket.io";
import { createServer } from "node:http";

describe("ZodNamespace", () => {
    it("should allow sending messages with the ZodSocketMessageCatalogSchema structure", async () => {
        const io = new Server(createServer());

        const clientMessages = {
            CLIENT_MSG: {
                message: z.object({ foo: z.string() })
            }
        };

        const serverMessages = {
            SERVER_MSG: {
                message: z.object({ bar: z.number() })
            }
        };

        const ns = new ZodNamespace({
            io,
            name: "test",
            clientMessages,
            serverMessages,
        });

        const emitSpy = vi.spyOn(ns.namespace, "emit");

        // This should not throw and should emit the correct payload
        // Currently this might throw or require passing { message: { bar: 1 } }
        await ns.sender.send("SERVER_MSG", { bar: 1 } as any);

        expect(emitSpy).toHaveBeenCalledWith("SERVER_MSG", {
            payload: { bar: 1 },
            version: "v1"
        });
    });

    it("should support schemas with callbacks if updated", async () => {
        // This test represents the desired state
        const io = new Server(createServer());

        const clientMessages = {
            CLIENT_MSG: {
                message: z.object({ foo: z.string() }),
                callback: z.object({ ok: z.boolean() })
            }
        };

        const serverMessages = {
            SERVER_MSG: {
                message: z.object({ bar: z.number() }),
                callback: z.object({ success: z.boolean() })
            }
        } as any; // Cast for now until we update the types

        const ns = new ZodNamespace({
            io,
            name: "test-cb",
            clientMessages,
            serverMessages,
        });

        expect(ns).toBeDefined();
    });
});
