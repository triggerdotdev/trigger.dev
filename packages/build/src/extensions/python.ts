import fs from "node:fs";
import { $ } from "execa";
import { assert } from "@std/assert";
import { BuildManifest } from "@trigger.dev/core/v3";
import { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import { logger } from "@trigger.dev/sdk/v3";

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
};

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
      this.options.requirements = fs
        .readFileSync(this.options.requirementsFile, "utf-8")
        .split("\n");
    }
  }

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") {
      if (this.options.pythonBinaryPath) {
        process.env.PYTHON_BIN_PATH = this.options.pythonBinaryPath;
      }

      return;
    }

    context.logger.debug(`Adding ${this.name} to the build`);

    context.addLayer({
      id: "python-extension",
      build: {
        env: {
          REQUIREMENTS_CONTENT: this.options.requirements?.join("\n") || "",
        },
      },
      image: {
        instructions: `
          # Install Python
          RUN apt-get update && apt-get install -y --no-install-recommends \
              python3 python3-pip python3-venv && \
              apt-get clean && rm -rf /var/lib/apt/lists/*

          # Set up Python environment
          RUN python3 -m venv /opt/venv
          ENV PATH="/opt/venv/bin:$PATH"

          ARG REQUIREMENTS_CONTENT
          RUN echo "$REQUIREMENTS_CONTENT" > requirements.txt

          # Install dependenciess
          RUN pip install --no-cache-dir -r requirements.txt
        `.split("\n"),
      },
      deploy: {
        env: {
          PYTHON_BIN_PATH: `/opt/venv/bin/python`,
        },
        override: true,
      },
    });
  }
}

export const run = async (
  args?: string,
  options: Parameters<typeof $>[1] = {}
) => {
  const cmd = `${process.env.PYTHON_BIN_PATH || "python"} ${args}`;

  logger.debug(
    `Running python:\t${cmd} ${options.input ? `(with stdin)` : ""}`,
    options
  );

  const result = await $({
    shell: true,
    ...options,
  })`${cmd}`;

  try {
    assert(!result.failed, `Command failed: ${result.stderr}`);
    assert(result.exitCode === 0, `Non-zero exit code: ${result.exitCode}`);
  } catch (e) {
    logger.error(e.message, result);
    throw e;
  }

  return result;
};

export default run;
