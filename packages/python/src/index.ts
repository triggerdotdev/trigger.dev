import fs from "node:fs";
import assert from "node:assert";
import { logger } from "@trigger.dev/sdk/v3";
import { x, Options as XOptions, Result } from "tinyexec";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3";
import { withTempFile } from "./utils/tempFiles.js";

export const python = {
  async run(scriptArgs: string[] = [], options: Partial<XOptions> = {}): Promise<Result> {
    const pythonBin = process.env.PYTHON_BIN_PATH || "python";

    return await logger.trace(
      "python.run()",
      async (span) => {
        const result = await x(pythonBin, scriptArgs, {
          ...options,
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
          [SemanticInternalAttributes.STYLE_ICON]: "brand-python",
        },
      }
    );
  },

  async runScript(
    scriptPath: string,
    scriptArgs: string[] = [],
    options: Partial<XOptions> = {}
  ): Promise<Result> {
    assert(scriptPath, "Script path is required");
    assert(fs.existsSync(scriptPath), `Script does not exist: ${scriptPath}`);

    return await logger.trace(
      "python.runScript()",
      async (span) => {
        span.setAttribute("scriptPath", scriptPath);

        const result = await x(
          process.env.PYTHON_BIN_PATH || "python",
          [scriptPath, ...scriptArgs],
          {
            ...options,
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
            }:\n${result.stderr}`
          );
        }

        return result;
      },
      {
        attributes: {
          pythonBin: process.env.PYTHON_BIN_PATH || "python",
          scriptPath,
          args: scriptArgs.join(" "),
          [SemanticInternalAttributes.STYLE_ICON]: "brand-python",
        },
      }
    );
  },

  async runInline(scriptContent: string, options: Partial<XOptions> = {}): Promise<Result> {
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

            const pythonBin = process.env.PYTHON_BIN_PATH || "python";
            const result = await x(pythonBin, [tempFilePath], {
              ...options,
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
          [SemanticInternalAttributes.STYLE_ICON]: "brand-python",
        },
      }
    );
  },
};
