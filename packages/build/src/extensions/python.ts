import fs from "node:fs";
import assert from "node:assert";
import { additionalFiles } from "./core/additionalFiles.js";
import { BuildManifest } from "@trigger.dev/core/v3";
import { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import { logger } from "@trigger.dev/sdk/v3";
import { x, Options as XOptions, Result } from "tinyexec";

export type PythonOptions = {
  requirements?: string[];
  requirementsFile?: string;
  /**
   * [Dev-only] The path to the python binary.
   *
   * @remarks
   * This option is typically used during local development or in specific testing environments
   * where a particular Python installation needs to be targeted.  It should point to the full path of the python executable.
   *
   * Example: `/usr/bin/python3` or `C:\\Python39\\python.exe`
   */
  pythonBinaryPath?: string;
  /**
   * An array of glob patterns that specify which Python scripts are allowed to be executed.
   *
   * @remarks
   * These scripts will be copied to the container during the build process.
   */
  scripts?: string[];
};

const splitAndCleanComments = (str: string) =>
  str
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

export function pythonExtension(options: PythonOptions = {}): BuildExtension {
  return new PythonExtension(options);
}

class PythonExtension implements BuildExtension {
  public readonly name = "PythonExtension";

  constructor(private options: PythonOptions = {}) {
    assert(
      !(this.options.requirements && this.options.requirementsFile),
      "Cannot specify both requirements and requirementsFile"
    );

    if (this.options.requirementsFile) {
      assert(
        fs.existsSync(this.options.requirementsFile),
        `Requirements file not found: ${this.options.requirementsFile}`
      );
      this.options.requirements = splitAndCleanComments(
        fs.readFileSync(this.options.requirementsFile, "utf-8")
      );
    }
  }

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    await additionalFiles({
      files: this.options.scripts ?? [],
    }).onBuildComplete!(context, manifest);

    if (context.target === "dev") {
      if (this.options.pythonBinaryPath) {
        process.env.PYTHON_BIN_PATH = this.options.pythonBinaryPath;
      }

      return;
    }

    context.logger.debug(`Adding ${this.name} to the build`);

    context.addLayer({
      id: "python-installation",
      image: {
        instructions: splitAndCleanComments(`
          # Install Python
          RUN apt-get update && apt-get install -y --no-install-recommends \
              python3 python3-pip python3-venv && \
              apt-get clean && rm -rf /var/lib/apt/lists/*

          # Set up Python environment
          RUN python3 -m venv /opt/venv
          ENV PATH="/opt/venv/bin:$PATH"
        `),
      },
      deploy: {
        env: {
          PYTHON_BIN_PATH: `/opt/venv/bin/python`,
        },
        override: true,
      },
    });

    context.addLayer({
      id: "python-dependencies",
      build: {
        env: {
          REQUIREMENTS_CONTENT: this.options.requirements?.join("\n") || "",
        },
      },
      image: {
        instructions: splitAndCleanComments(`
          ARG REQUIREMENTS_CONTENT
          RUN echo "$REQUIREMENTS_CONTENT" > requirements.txt

          # Install dependencies
          RUN pip install --no-cache-dir -r requirements.txt
        `),
      },
      deploy: {
        override: true,
      },
    });
  }
}

export const run = async (
  scriptArgs: string[] = [],
  options: Partial<XOptions> = {}
): Promise<Result> => {
  const pythonBin = process.env.PYTHON_BIN_PATH || "python";

  const result = await x(pythonBin, scriptArgs, {
    ...options,
    throwOnError: false, // Ensure errors are handled manually
  });

  try {
    assert(
      result.exitCode === 0,
      `Python command exited with non-zero code ${result.exitCode}\nStdout: ${result.stdout}\nStderr: ${result.stderr}`
    );
  } catch (error) {
    logger.error("Python command execution failed", {
      error: error instanceof Error ? error.message : error,
      command: `${pythonBin} ${scriptArgs.join(" ")}`,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
    throw error;
  }

  return result;
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
    await fs.promises.unlink(tmpFile);
  }
};

export default { run, runScript, runInline };
