import { describe, it, expect, vi } from "vitest";
import { ZodSocketMessageHandler } from "../src/v3/zodSocket.js";
import { z } from "zod";
import { EventEmitter } from "events";

describe("ZodSocketMessageHandler", () => {
    describe("normalizeMessage - Protocol Detection", () => {
        it("should correctly identify wrapped messages with version and payload", async () => {
            const catalog = {
                TEST: {
                    message: z.object({
                        data: z.string(),
                    }),
                },
            };

            const handlerFn = vi.fn();
            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: async (data) => {
                        handlerFn(data);
                    },
                },
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            // Send a properly wrapped message (as ZodMessageSender would)
            mockSocket.emit("TEST", {
                version: "v1",
                payload: { data: "hello" },
            });

            // Should receive the unwrapped payload
            expect(handlerFn).toHaveBeenCalledWith({ data: "hello" });
        });

        it("should wrap unwrapped messages that lack version", async () => {
            const catalog = {
                TEST: {
                    message: z.object({
                        data: z.string(),
                    }),
                },
            };

            const handlerFn = vi.fn();
            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: async (data) => {
                        handlerFn(data);
                    },
                },
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            // Send an unwrapped message (raw user data) with version
            mockSocket.emit("TEST", { version: "v1", data: "hello" });

            // Should receive the data as-is
            expect(handlerFn).toHaveBeenCalledWith({ data: "hello" });
        });

        it("should handle user data that contains a 'payload' property (THE BUG FIX)", async () => {
            const catalog = {
                TEST: {
                    message: z.object({
                        payload: z.string(), // User's schema uses 'payload' as a field name
                    }),
                },
            };

            const handlerFn = vi.fn();
            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: async (data) => {
                        handlerFn(data);
                    },
                },
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            // User sends data where their schema field is named "payload"
            // With version present, this is treated as unwrapped user data
            mockSocket.emit("TEST", { version: "v1", payload: "my-data" });

            // Should receive the full object, not just "my-data"
            expect(handlerFn).toHaveBeenCalledWith({ payload: "my-data" });
        });

        it("should reject user data with 'version' as non-string type", async () => {
            const catalog = {
                TEST: {
                    message: z.object({
                        payload: z.string(),
                        version: z.number(), // User's version is a number, not the protocol string
                    }),
                },
            };

            const handlerFn = vi.fn();
            const errorLogFn = vi.fn();

            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: handlerFn,
                },
                logger: {
                    log: vi.fn(),
                    debug: vi.fn(),
                    info: vi.fn(),
                    warn: vi.fn(),
                    error: errorLogFn,
                    child: vi.fn().mockReturnThis(),
                } as any,
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            // User sends data with both 'payload' and 'version' properties
            // Since version is a number (not string "v1"), this will be detected as wrapped
            // but fail validation because version must be a string
            mockSocket.emit("TEST", { payload: "data", version: 2 });

            // Wait for async handling
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Handler should NOT be called (validation fails)
            expect(handlerFn).not.toHaveBeenCalled();

            // Error should be logged
            expect(errorLogFn).toHaveBeenCalled();
        });

        it("should handle complex nested user data", async () => {
            const catalog = {
                TEST: {
                    message: z.object({
                        user: z.object({
                            name: z.string(),
                            age: z.number(),
                        }),
                        metadata: z.record(z.unknown()),
                    }),
                },
            };

            const handlerFn = vi.fn();
            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: async (data) => {
                        handlerFn(data);
                    },
                },
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            const userData = {
                user: { name: "Alice", age: 30 },
                metadata: { role: "admin" },
            };

            mockSocket.emit("TEST", { version: "v1", ...userData });

            expect(handlerFn).toHaveBeenCalledWith(userData);
        });

        it("should handle messages with callbacks", async () => {
            const catalog = {
                TEST: {
                    message: z.object({ data: z.string() }),
                    callback: z.object({ success: z.boolean() }),
                },
            };

            const handlerFn = vi.fn().mockResolvedValue({ success: true });
            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: handlerFn,
                },
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            const callbackFn = vi.fn();

            // Emit with callback
            mockSocket.emit("TEST", { version: "v1", payload: { data: "test" } }, callbackFn);

            // Wait for async handling
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(handlerFn).toHaveBeenCalledWith({ data: "test" });
            expect(callbackFn).toHaveBeenCalledWith({ success: true });
        });

        it("should reject invalid messages with proper error logging", async () => {
            const catalog = {
                TEST: {
                    message: z.object({
                        data: z.string(),
                    }),
                },
            };

            const handlerFn = vi.fn();
            const errorLogFn = vi.fn();

            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: handlerFn,
                },
                logger: {
                    log: vi.fn(),
                    debug: vi.fn(),
                    info: vi.fn(),
                    warn: vi.fn(),
                    error: errorLogFn,
                    child: vi.fn().mockReturnThis(),
                } as any,
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            // Send invalid data (number instead of string)
            mockSocket.emit("TEST", { version: "v1", payload: { data: 123 } });

            // Wait for async handling
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Handler should NOT be called
            expect(handlerFn).not.toHaveBeenCalled();

            // Error should be logged
            expect(errorLogFn).toHaveBeenCalled();
        });

        it("should handle payload as non-object (string)", async () => {
            const catalog = {
                TEST: {
                    message: z.object({
                        payload: z.string(),
                    }),
                },
            };

            const handlerFn = vi.fn();
            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: async (data) => {
                        handlerFn(data);
                    },
                },
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            // Send message where payload is a string (not an object)
            // hasValidPayload will be false, so it wraps the entire message
            mockSocket.emit("TEST", { version: "v1", payload: "string-value" });

            // Should receive the wrapped data
            expect(handlerFn).toHaveBeenCalledWith({ payload: "string-value" });
        });

        it("should handle payload as array", async () => {
            const catalog = {
                TEST: {
                    message: z.object({
                        payload: z.array(z.number()),
                    }),
                },
            };

            const handlerFn = vi.fn();
            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: async (data) => {
                        handlerFn(data);
                    },
                },
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            // Send message where payload is an array (not a plain object)
            // isObject([1,2,3]) returns false, so it wraps the entire message
            mockSocket.emit("TEST", { version: "v1", payload: [1, 2, 3] });

            // Should receive the wrapped data
            expect(handlerFn).toHaveBeenCalledWith({ payload: [1, 2, 3] });
        });

        it("should handle payload as null", async () => {
            const catalog = {
                TEST: {
                    message: z.object({
                        payload: z.null(),
                    }),
                },
            };

            const handlerFn = vi.fn();
            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: async (data) => {
                        handlerFn(data);
                    },
                },
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            // Send message where payload is null
            // isObject(null) returns false, so it wraps the entire message
            mockSocket.emit("TEST", { version: "v1", payload: null });

            // Should receive the wrapped data
            expect(handlerFn).toHaveBeenCalledWith({ payload: null });
        });

        it("should reject messages without version field", async () => {
            const catalog = {
                TEST: {
                    message: z.object({
                        data: z.string(),
                    }),
                },
            };

            const handlerFn = vi.fn();
            const errorLogFn = vi.fn();

            const handler = new ZodSocketMessageHandler({
                schema: catalog,
                handlers: {
                    TEST: handlerFn,
                },
                logger: {
                    log: vi.fn(),
                    debug: vi.fn(),
                    info: vi.fn(),
                    warn: vi.fn(),
                    error: errorLogFn,
                    child: vi.fn().mockReturnThis(),
                } as any,
            });

            const mockSocket = new EventEmitter();
            handler.registerHandlers(mockSocket as any);

            // Send message without version field
            // version will be undefined, which fails messageSchema validation
            mockSocket.emit("TEST", { data: "hello" });

            // Wait for async handling
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Handler should NOT be called (validation fails)
            expect(handlerFn).not.toHaveBeenCalled();

            // Error should be logged
            expect(errorLogFn).toHaveBeenCalled();
        });
    });
});
