import {
  resourceCatalog,
  RunHandle,
  type SandboxPayload,
  SandboxPayloadSchema,
  TaskRunPromise,
  TriggerAndWaitOptions,
} from "@trigger.dev/core/v3";
import { Task, TaskOptions, createSchemaTask } from "./shared.js";

/**
 * The options for defining a sandbox task.
 */
export type SandboxOptions<TIdentifier extends string> = Pick<
  TaskOptions<TIdentifier, SandboxPayload>,
  "id" | "description" | "machine" | "retry" | "queue" | "maxDuration"
> & {
  /**
   * The npm/jsr packages to install in the sandbox.
   */
  packages: string[];
  /**
   * The system packages to install in the sandbox.
   */
  systemPackages: string[];
  /**
   * The runtime to use for the sandbox.
   */
  runtime: "node:22" | "node:24" | "bun:1.3.0";
};

export type RunCodeOptions = TriggerAndWaitOptions;

export type SandboxTask<TIdentifier extends string> = Task<TIdentifier, SandboxPayload> & {
  runCodeAndWait: <TOutput extends any>(
    payload: SandboxPayload,
    options?: RunCodeOptions
  ) => TaskRunPromise<TIdentifier, TOutput>;
  runCode: <TOutput extends any>(
    payload: SandboxPayload,
    options?: RunCodeOptions
  ) => Promise<RunHandle<TIdentifier, SandboxPayload, TOutput>>;
};

function defineSandbox<TIdentifier extends string>(
  params: SandboxOptions<TIdentifier>
): SandboxTask<TIdentifier> {
  const task = createSchemaTask<TIdentifier, typeof SandboxPayloadSchema>({
    ...params,
    schema: SandboxPayloadSchema,
    run: async (payload) => {
      return {} as any;
    },
  });

  resourceCatalog.updateTaskMetadata(task.id, {
    triggerSource: "sandbox",
    sandbox: {
      packages: params.packages,
      systemPackages: params.systemPackages,
      runtime: params.runtime,
    },
  });

  return {
    ...task,
    runCodeAndWait: (payload, options) => {
      return task.triggerAndWait(payload, options) as TaskRunPromise<TIdentifier, any>;
    },
    runCode: async (payload, options) => {
      return (await task.trigger(payload, options)) as RunHandle<TIdentifier, SandboxPayload, any>;
    },
  };
}

export const sandbox = {
  /**
   * Define a sandbox task.
   * @param params - The parameters for the sandbox task.
   * @returns The sandbox task.
   */
  define: defineSandbox,
};
