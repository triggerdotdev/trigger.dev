import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConsoleInterceptor } from "./consoleInterceptor";
import * as logsAPI from "@opentelemetry/api-logs";

const mockLogger = {
    emit: vi.fn(),
} as unknown as logsAPI.Logger;

describe("ConsoleInterceptor", () => {
    let originalConsoleLog: any;

    beforeEach(() => {
        originalConsoleLog = console.log;
    });

    afterEach(() => {
        console.log = originalConsoleLog;
    });

    it("should call the original console method even if sendToStdIO is false (to preserve chain)", async () => {
        const middlewareLog = vi.fn();
        console.log = middlewareLog; // Simulate Sentry or other interceptor

        const interceptor = new ConsoleInterceptor(
            mockLogger,
            false, // sendToStdIO = false
            false  // interceptingDisabled = false
        );

        await interceptor.intercept(console, async () => {
            console.log("test message");
        });

        // Currently this fails because sendToStdIO is false, so it doesn't call originalConsole.log
        expect(middlewareLog).toHaveBeenCalledWith("test message");
    });
});
