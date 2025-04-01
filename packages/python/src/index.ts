import {
  AsyncIterableStream,
  createAsyncIterableStreamFromAsyncIterable,
  SemanticInternalAttributes,
  taskContext,
} from "@trigger.dev/core/v3";
import { logger } from "@trigger.dev/sdk/v3";
import { carrierFromContext } from "@trigger.dev/core/v3/otel";
import assert from "node:assert";
import fs from "node:fs";
import { Result, x, Options as XOptions } from "tinyexec";
import { createTempFileSync, withTempFile } from "./utils/tempFiles.js";

export type PythonExecOptions = Partial<XOptions> & {
  env?: { [key: string]: string | undefined };
};

export const python = {
  async run(scriptArgs: string[] = [], options: PythonExecOptions = {}): Promise<Result> {
    const pythonBin = process.env.PYTHON_BIN_PATH || "python";

    const carrier = carrierFromContext();

    return await logger.trace(
      "python.run()",
      async (span) => {
        const result = await x(pythonBin, scriptArgs, {
          ...options,
          nodeOptions: {
            ...(options.nodeOptions || {}),
            env: {
              ...process.env,
              ...options.env,
              TRACEPARENT: carrier["traceparent"],
              OTEL_RESOURCE_ATTRIBUTES: `${
                SemanticInternalAttributes.EXECUTION_ENVIRONMENT
              }=trigger,${Object.entries(taskContext.attributes)
                .map(([key, value]) => `${key}=${value}`)
                .join(",")}`,
            },
          },
          throwOnError: false, // Ensure errors are handled manually
        });

        if (result.exitCode) {
          span.setAttribute("exitCode", result.exitCode);
        }

        if (result.exitCode !== 0) {
          throw new Error(
            `${scriptArgs.join(" ")} exited with a non-zero code ${result.exitCode}:\n${
              result.stderr
            }`
          );
        }

        return result;
      },
      {
        attributes: {
          pythonBin,
          args: scriptArgs.join(" "),
          [SemanticInternalAttributes.STYLE_ICON]: "python",
        },
      }
    );
  },

  async runScript(
    scriptPath: string,
    scriptArgs: string[] = [],
    options: PythonExecOptions = {}
  ): Promise<Result> {
    assert(scriptPath, "Script path is required");
    assert(fs.existsSync(scriptPath), `Script does not exist: ${scriptPath}`);

    return await logger.trace(
      "python.runScript()",
      async (span) => {
        span.setAttribute("scriptPath", scriptPath);

        const carrier = carrierFromContext();

        const result = await x(
          process.env.PYTHON_BIN_PATH || "python",
          [scriptPath, ...scriptArgs],
          {
            ...options,
            nodeOptions: {
              ...(options.nodeOptions || {}),
              env: {
                ...process.env,
                ...options.env,
                TRACEPARENT: carrier["traceparent"],
                OTEL_RESOURCE_ATTRIBUTES: `${
                  SemanticInternalAttributes.EXECUTION_ENVIRONMENT
                }=trigger,${Object.entries(taskContext.attributes)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(",")}`,
                OTEL_LOG_LEVEL: "DEBUG",
              },
            },
            throwOnError: false,
          }
        );

        if (result.exitCode) {
          span.setAttribute("exitCode", result.exitCode);
        }

        if (result.exitCode !== 0) {
          throw new Error(
            `${scriptPath} ${scriptArgs.join(" ")} exited with a non-zero code ${
              result.exitCode
            }:\n${result.stdout}\n${result.stderr}`
          );
        }

        return result;
      },
      {
        attributes: {
          pythonBin: process.env.PYTHON_BIN_PATH || "python",
          scriptPath,
          args: scriptArgs.join(" "),
          [SemanticInternalAttributes.STYLE_ICON]: "python",
        },
      }
    );
  },

  async runInline(scriptContent: string, options: PythonExecOptions = {}): Promise<Result> {
    assert(scriptContent, "Script content is required");

    return await logger.trace(
      "python.runInline()",
      async (span) => {
        span.setAttribute("contentLength", scriptContent.length);

        // Using the withTempFile utility to handle the temporary file
        return await withTempFile(
          `script_${Date.now()}.py`,
          async (tempFilePath) => {
            span.setAttribute("tempFilePath", tempFilePath);

            const carrier = carrierFromContext();

            const pythonBin = process.env.PYTHON_BIN_PATH || "python";
            const result = await x(pythonBin, [tempFilePath], {
              ...options,
              nodeOptions: {
                ...(options.nodeOptions || {}),
                env: {
                  ...process.env,
                  ...options.env,
                  TRACEPARENT: carrier["traceparent"],
                  OTEL_RESOURCE_ATTRIBUTES: `${
                    SemanticInternalAttributes.EXECUTION_ENVIRONMENT
                  }=trigger,${Object.entries(taskContext.attributes)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(",")}`,
                },
              },
              throwOnError: false,
            });

            if (result.exitCode) {
              span.setAttribute("exitCode", result.exitCode);
            }

            if (result.exitCode !== 0) {
              throw new Error(
                `Inline script exited with a non-zero code ${result.exitCode}:\n${result.stderr}`
              );
            }

            return result;
          },
          scriptContent
        );
      },
      {
        attributes: {
          pythonBin: process.env.PYTHON_BIN_PATH || "python",
          contentPreview:
            scriptContent.substring(0, 100) + (scriptContent.length > 100 ? "..." : ""),
          [SemanticInternalAttributes.STYLE_ICON]: "python",
        },
      }
    );
  },
  // Stream namespace for streaming functions
  stream: {
    run(scriptArgs: string[] = [], options: PythonExecOptions = {}): AsyncIterableStream<string> {
      const pythonBin = process.env.PYTHON_BIN_PATH || "python";

      const carrier = carrierFromContext();

      const pythonProcess = x(pythonBin, scriptArgs, {
        ...options,
        nodeOptions: {
          ...(options.nodeOptions || {}),
          env: {
            ...process.env,
            ...options.env,
            TRACEPARENT: carrier["traceparent"],
            OTEL_RESOURCE_ATTRIBUTES: `${
              SemanticInternalAttributes.EXECUTION_ENVIRONMENT
            }=trigger,${Object.entries(taskContext.attributes)
              .map(([key, value]) => `${key}=${value}`)
              .join(",")}`,
          },
        },
        throwOnError: false,
      });

      const span = logger.startSpan("python.stream.run()", {
        attributes: {
          pythonBin,
          args: scriptArgs.join(" "),
          [SemanticInternalAttributes.STYLE_ICON]: "python",
        },
      });

      return createAsyncIterableStreamFromAsyncIterable(pythonProcess, {
        transform: (chunk, controller) => {
          controller.enqueue(chunk);
        },
        flush: () => {
          span.end();
        },
      });
    },
    runScript(
      scriptPath: string,
      scriptArgs: string[] = [],
      options: PythonExecOptions = {}
    ): AsyncIterableStream<string> {
      assert(scriptPath, "Script path is required");
      assert(fs.existsSync(scriptPath), `Script does not exist: ${scriptPath}`);

      const pythonBin = process.env.PYTHON_BIN_PATH || "python";

      const carrier = carrierFromContext();

      const pythonProcess = x(pythonBin, [scriptPath, ...scriptArgs], {
        ...options,
        nodeOptions: {
          ...(options.nodeOptions || {}),
          env: {
            ...process.env,
            ...options.env,
            TRACEPARENT: carrier["traceparent"],
            OTEL_RESOURCE_ATTRIBUTES: `${
              SemanticInternalAttributes.EXECUTION_ENVIRONMENT
            }=trigger,${Object.entries(taskContext.attributes)
              .map(([key, value]) => `${key}=${value}`)
              .join(",")}`,
          },
        },
        throwOnError: false,
      });

      const span = logger.startSpan("python.stream.runScript()", {
        attributes: {
          pythonBin,
          scriptPath,
          args: scriptArgs.join(" "),
          [SemanticInternalAttributes.STYLE_ICON]: "python",
        },
      });

      return createAsyncIterableStreamFromAsyncIterable(pythonProcess, {
        transform: (chunk, controller) => {
          controller.enqueue(chunk);
        },
        flush: () => {
          span.end();
        },
      });
    },
    runInline(scriptContent: string, options: PythonExecOptions = {}): AsyncIterableStream<string> {
      assert(scriptContent, "Script content is required");

      const pythonBin = process.env.PYTHON_BIN_PATH || "python";

      const pythonScriptPath = createTempFileSync(`script_${Date.now()}.py`, scriptContent);

      const carrier = carrierFromContext();

      const pythonProcess = x(pythonBin, [pythonScriptPath], {
        ...options,
        nodeOptions: {
          ...(options.nodeOptions || {}),
          env: {
            ...process.env,
            ...options.env,
            TRACEPARENT: carrier["traceparent"],
            OTEL_RESOURCE_ATTRIBUTES: `${
              SemanticInternalAttributes.EXECUTION_ENVIRONMENT
            }=trigger,${Object.entries(taskContext.attributes)
              .map(([key, value]) => `${key}=${value}`)
              .join(",")}`,
          },
        },
        throwOnError: false,
      });

      const span = logger.startSpan("python.stream.runInline()", {
        attributes: {
          pythonBin,
          contentPreview:
            scriptContent.substring(0, 100) + (scriptContent.length > 100 ? "..." : ""),
          [SemanticInternalAttributes.STYLE_ICON]: "python",
        },
      });

      return createAsyncIterableStreamFromAsyncIterable(pythonProcess, {
        transform: (chunk, controller) => {
          controller.enqueue(chunk);
        },
        flush: () => {
          span.end();
        },
      });
    },
  },
};
