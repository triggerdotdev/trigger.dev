import fs from "node:fs";
import assert from "node:assert";
import { logger } from "@trigger.dev/sdk/v3";
import { x, Options as XOptions, Result } from "tinyexec";

export const run = async (
  scriptArgs: string[] = [],
  options: Partial<XOptions> = {}
): Promise<Result> => {
  const pythonBin = process.env.PYTHON_BIN_PATH || "python";

  return await logger.trace("Python call", async (span) => {
    span.addEvent("Properties", {
      command: `${pythonBin} ${scriptArgs.join(" ")}`,
    });

    const result = await x(pythonBin, scriptArgs, {
      ...options,
      throwOnError: false, // Ensure errors are handled manually
    });

    span.addEvent("Output", { ...result });

    if (result.exitCode !== 0) {
      logger.error(result.stderr, { ...result });
      throw new Error(`Python command exited with non-zero code ${result.exitCode}`);
    }

    return result;
  });
};

export const runScript = (
  scriptPath: string,
  scriptArgs: string[] = [],
  options: Partial<XOptions> = {}
) => {
  assert(scriptPath, "Script path is required");
  assert(fs.existsSync(scriptPath), `Script does not exist: ${scriptPath}`);

  return run([scriptPath, ...scriptArgs], options);
};

export const runInline = async (scriptContent: string, options: Partial<XOptions> = {}) => {
  assert(scriptContent, "Script content is required");

  const tmpFile = `/tmp/script_${Date.now()}.py`;
  await fs.promises.writeFile(tmpFile, scriptContent, { mode: 0o600 });

  try {
    return await runScript(tmpFile, [], options);
  } finally {
    try {
      await fs.promises.unlink(tmpFile);
    } catch (error) {
      logger.warn(`Failed to clean up temporary file ${tmpFile}:`, {
        error: (error as Error).stack || (error as Error).message,
      });
    }
  }
};

export default { run, runScript, runInline };
