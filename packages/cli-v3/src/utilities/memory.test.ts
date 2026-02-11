import { expect, test, vi, describe, beforeEach, afterEach } from "vitest";
import { ensureSufficientMemory } from "./memory.js";
import { spawn } from "node:child_process";
import { getHeapStatistics } from "node:v8";

vi.mock("node:child_process", () => ({
    spawn: vi.fn(() => ({
        on: vi.fn(),
    })),
}));

vi.mock("node:v8", () => ({
    getHeapStatistics: vi.fn(),
}));

vi.mock("./logger.js", () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}));

describe("ensureSufficientMemory", () => {
    const originalEnv = process.env;
    const originalArgv = process.argv;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
        process.argv = ["node", "trigger", "deploy"];
    });

    afterEach(() => {
        process.env = originalEnv;
        process.argv = originalArgv;
    });

    test("should not respawn if memory limit is already high enough", () => {
        vi.mocked(getHeapStatistics).mockReturnValue({
            heap_size_limit: 5000 * 1024 * 1024, // 5GB
        } as any);

        const result = ensureSufficientMemory();
        expect(result).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
    });

    test("should not respawn if TRIGGER_CLI_MEMORY_RESPAWNED is set", () => {
        process.env.TRIGGER_CLI_MEMORY_RESPAWNED = "1";
        vi.mocked(getHeapStatistics).mockReturnValue({
            heap_size_limit: 1000 * 1024 * 1024, // 1GB
        } as any);

        const result = ensureSufficientMemory();
        expect(result).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
    });

    test("should not respawn if command is not memory intensive", () => {
        process.argv = ["node", "trigger", "whoami"];
        vi.mocked(getHeapStatistics).mockReturnValue({
            heap_size_limit: 1000 * 1024 * 1024, // 1GB
        } as any);

        const result = ensureSufficientMemory();
        expect(result).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
    });

    test("should respawn if memory limit is low and command is deploy", () => {
        process.argv = ["node", "trigger", "deploy"];
        vi.mocked(getHeapStatistics).mockReturnValue({
            heap_size_limit: 2000 * 1024 * 1024, // 2GB
        } as any);

        const result = ensureSufficientMemory();
        expect(result).toBe(true);
        expect(spawn).toHaveBeenCalledWith(
            process.execPath,
            expect.arrayContaining(["--max-old-space-size=4096"]),
            expect.objectContaining({
                env: expect.objectContaining({
                    TRIGGER_CLI_MEMORY_RESPAWNED: "1",
                }),
            })
        );
    });
});
