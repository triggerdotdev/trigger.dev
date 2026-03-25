import { describe, it, expect, vi, beforeEach } from "vitest";
import { streams } from "./streams.js";
import { taskContext, realtimeStreams } from "@trigger.dev/core/v3";

vi.mock("@trigger.dev/core/v3", async (importOriginal) => {
    const original = await importOriginal<typeof import("@trigger.dev/core/v3")>();
    return {
        ...original,
        taskContext: {
            ctx: {
                run: {
                    id: "run_123",
                    // parentTaskRunId and rootTaskRunId are undefined for root tasks
                },
            },
        },
        realtimeStreams: {
            pipe: vi.fn().mockReturnValue({
                wait: () => Promise.resolve(),
                stream: new ReadableStream(),
            }),
        },
    };
});

describe("streams.pipe consistency", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should not throw and should use self runId when target is 'root' in a root task", async () => {
        const mockStream = new ReadableStream();

        // This should not throw anymore
        const { waitUntilComplete } = streams.pipe("test-key", mockStream, {
            target: "root",
        });

        expect(realtimeStreams.pipe).toHaveBeenCalledWith(
            "test-key",
            mockStream,
            expect.objectContaining({
                target: "run_123",
            })
        );
    });

    it("should not throw and should use self runId when target is 'parent' in a root task", async () => {
        const mockStream = new ReadableStream();

        // This should not throw anymore
        const { waitUntilComplete } = streams.pipe("test-key", mockStream, {
            target: "parent",
        });

        expect(realtimeStreams.pipe).toHaveBeenCalledWith(
            "test-key",
            mockStream,
            expect.objectContaining({
                target: "run_123",
            })
        );
    });
});
