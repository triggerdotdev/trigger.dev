import { describe, expect, it } from "vitest";
import { SharedRuntimeManager } from "./sharedRuntimeManager.js";
import { CompletedWaitpoint } from "../schemas/index.js";

describe("SharedRuntimeManager", () => {
    const mockIpc = {
        send: () => { },
    } as any;

    const manager = new SharedRuntimeManager(mockIpc, false);

    // Access private method
    const waitpointToResult = (manager as any).waitpointToTaskRunExecutionResult.bind(manager);

    describe("waitpointToTaskRunExecutionResult", () => {
        it("should use the taskIdentifier from the waitpoint if present (success)", () => {
            const waitpoint: CompletedWaitpoint = {
                id: "wp_1",
                friendlyId: "wp_1",
                type: "RUN",
                completedAt: new Date(),
                outputIsError: false,
                output: JSON.stringify({ foo: "bar" }),
                outputType: "application/json",
                completedByTaskRun: {
                    id: "run_1",
                    friendlyId: "run_1",
                    taskIdentifier: "my-task",
                },
            };

            const result = waitpointToResult(waitpoint);

            expect(result).toEqual({
                ok: true,
                id: "run_1",
                taskIdentifier: "my-task",
                output: JSON.stringify({ foo: "bar" }),
                outputType: "application/json",
            });
        });

        it("should default taskIdentifier to 'unknown' if missing (success)", () => {
            const waitpoint: CompletedWaitpoint = {
                id: "wp_2",
                friendlyId: "wp_2",
                type: "RUN",
                completedAt: new Date(),
                outputIsError: false,
                output: JSON.stringify({ foo: "bar" }),
                outputType: "application/json",
                completedByTaskRun: {
                    id: "run_2",
                    friendlyId: "run_2",
                    // database/legacy object missing taskIdentifier
                } as any,
            };

            const result = waitpointToResult(waitpoint);

            expect(result).toEqual({
                ok: true,
                id: "run_2",
                taskIdentifier: "unknown",
                output: JSON.stringify({ foo: "bar" }),
                outputType: "application/json",
            });
        });

        it("should use the taskIdentifier from the waitpoint if present (failure)", () => {
            const waitpoint: CompletedWaitpoint = {
                id: "wp_3",
                friendlyId: "wp_3",
                type: "RUN",
                completedAt: new Date(),
                outputIsError: true,
                output: JSON.stringify({ message: "Boom" }),
                outputType: "application/json",
                completedByTaskRun: {
                    id: "run_3",
                    friendlyId: "run_3",
                    taskIdentifier: "my-failed-task",
                },
            };

            const result = waitpointToResult(waitpoint);

            expect(result).toEqual({
                ok: false,
                id: "run_3",
                taskIdentifier: "my-failed-task",
                error: { message: "Boom" },
            });
        });

        it("should default taskIdentifier to 'unknown' if missing (failure)", () => {
            const waitpoint: CompletedWaitpoint = {
                id: "wp_4",
                friendlyId: "wp_4",
                type: "RUN",
                completedAt: new Date(),
                outputIsError: true,
                output: JSON.stringify({ message: "Boom" }),
                outputType: "application/json",
                completedByTaskRun: {
                    id: "run_4",
                    friendlyId: "run_4",
                } as any,
            };

            const result = waitpointToResult(waitpoint);

            expect(result).toEqual({
                ok: false,
                id: "run_4",
                taskIdentifier: "unknown",
                error: { message: "Boom" },
            });
        });
    });
});
