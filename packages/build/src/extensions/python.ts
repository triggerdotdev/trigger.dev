import fs from "node:fs";
import { execa } from "execa";
import { assert } from "@std/assert";
import { additionalFiles } from "@trigger.dev/build/extensions/core";
import { BuildManifest } from "@trigger.dev/core/v3";
import { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import { logger } from "@trigger.dev/sdk/v3";

import type { VerboseObject } from "execa";

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

type ExecaOptions = Parameters<typeof execa>[1];

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

export const run = async (scriptArgs: string[] = [], options: ExecaOptions = {}) => {
  const pythonBin = process.env.PYTHON_BIN_PATH || "python";

  const result = await execa({
    shell: true,
    verbose: (verboseLine: string, verboseObject: VerboseObject) =>
      logger.debug(verboseObject.message, verboseObject),
    ...options,
  })(pythonBin, scriptArgs);

  try {
    assert(!result.failed, `Command failed: ${result.stderr}`);
    assert(result.exitCode === 0, `Non-zero exit code: ${result.exitCode}`);
  } catch (e) {
    logger.error(e.message, result);
    throw e;
  }

  return result;
};

export const runScript = (
  scriptPath: string,
  scriptArgs: string[] = [],
  options: ExecaOptions = {}
) => {
  assert(scriptPath, "Script path is required");
  assert(fs.existsSync(scriptPath), `Script does not exist: ${scriptPath}`);

  return run([scriptPath, ...scriptArgs], options);
};

export const runInline = (scriptContent: string, options: ExecaOptions = {}) => {
  assert(scriptContent, "Script content is required");

  return run([""], { input: scriptContent, ...options });
};

export default { run, runScript, runInline };
