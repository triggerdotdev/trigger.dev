import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { type Result, x } from "tinyexec";

class TinyResult {
  pid?: number;
  exitCode?: number;
  aborted: boolean;
  killed: boolean;

  constructor(result: Result) {
    this.pid = result.pid;
    this.exitCode = result.exitCode;
    this.aborted = result.aborted;
    this.killed = result.killed;
  }
}

interface ExecOptions {
  logger?: SimpleStructuredLogger;
  abortSignal?: AbortSignal;
  logOutput?: boolean;
  trimArgs?: boolean;
  neverThrow?: boolean;
}

export class Exec {
  private logger: SimpleStructuredLogger;
  private abortSignal: AbortSignal | undefined;

  private logOutput: boolean;
  private trimArgs: boolean;
  private neverThrow: boolean;

  constructor(opts: ExecOptions) {
    this.logger = opts.logger ?? new SimpleStructuredLogger("exec");
    this.abortSignal = opts.abortSignal;

    this.logOutput = opts.logOutput ?? true;
    this.trimArgs = opts.trimArgs ?? true;
    this.neverThrow = opts.neverThrow ?? false;
  }

  async x(
    command: string,
    args?: string[],
    opts?: { neverThrow?: boolean; ignoreAbort?: boolean }
  ) {
    const argsTrimmed = this.trimArgs ? args?.map((arg) => arg.trim()) : args;

    const commandWithFirstArg = `${command}${argsTrimmed?.length ? ` ${argsTrimmed[0]}` : ""}`;
    this.logger.debug(`exec: ${commandWithFirstArg}`, { command, args, argsTrimmed });

    const result = x(command, argsTrimmed, {
      signal: opts?.ignoreAbort ? undefined : this.abortSignal,
      // We don't use this as it doesn't cover killed and aborted processes
      // throwOnError: true,
    });

    const output = await result;

    const metadata = {
      command,
      argsRaw: args,
      argsTrimmed,
      globalOpts: {
        trimArgs: this.trimArgs,
        neverThrow: this.neverThrow,
        hasAbortSignal: !!this.abortSignal,
      },
      localOpts: opts,
      stdout: output.stdout,
      stderr: output.stderr,
      pid: result.pid,
      exitCode: result.exitCode,
      aborted: result.aborted,
      killed: result.killed,
    };

    if (this.logOutput) {
      this.logger.debug(`output: ${commandWithFirstArg}`, metadata);
    }

    if (this.neverThrow || opts?.neverThrow) {
      return output;
    }

    if (result.aborted) {
      this.logger.error(`aborted: ${commandWithFirstArg}`, metadata);
      throw new TinyResult(result);
    }

    if (result.killed) {
      this.logger.error(`killed: ${commandWithFirstArg}`, metadata);
      throw new TinyResult(result);
    }

    if (result.exitCode !== 0) {
      this.logger.error(`non-zero exit: ${commandWithFirstArg}`, metadata);
      throw new TinyResult(result);
    }

    return output;
  }

  static Result = TinyResult;
}

interface BuildahOptions {
  id?: string;
  abortSignal?: AbortSignal;
}

export class Buildah {
  private id: string;
  private logger: SimpleStructuredLogger;
  private exec: Exec;

  private containers = new Set<string>();
  private images = new Set<string>();

  constructor(opts: BuildahOptions) {
    this.id = opts.id ?? randomUUID();
    this.logger = new SimpleStructuredLogger("buildah", undefined, { id: this.id });

    this.exec = new Exec({
      logger: this.logger,
      abortSignal: opts.abortSignal,
    });

    this.logger.log("initiaized", { opts });
  }

  private get x() {
    return this.exec.x.bind(this.exec);
  }

  async from(baseImage: string) {
    const output = await this.x("buildah", ["from", baseImage]);
    this.containers.add(output.stdout);
    return output;
  }

  async add(container: string, src: string, dest: string) {
    return await this.x("buildah", ["add", container, src, dest]);
  }

  async config(container: string, annotations: string[]) {
    const args = ["config"];

    for (const annotation of annotations) {
      args.push(`--annotation=${annotation}`);
    }

    args.push(container);

    return await this.x("buildah", args);
  }

  async commit(container: string, imageRef: string) {
    const output = await this.x("buildah", ["commit", container, imageRef]);
    this.images.add(output.stdout);
    return output;
  }

  async push(imageRef: string, registryTlsVerify?: boolean) {
    return await this.x("buildah", [
      "push",
      `--tls-verify=${String(!!registryTlsVerify)}`,
      imageRef,
    ]);
  }

  async cleanup() {
    if (this.containers.size > 0) {
      try {
        const output = await this.x("buildah", ["rm", ...this.containers], { ignoreAbort: true });
        this.containers.clear();

        if (output.stderr.length > 0) {
          this.logger.error("failed to remove some containers", { output });
        }
      } catch (error) {
        this.logger.error("failed to clean up containers", { error, containers: this.containers });
      }
    } else {
      this.logger.debug("no containers to clean up");
    }

    if (this.images.size > 0) {
      try {
        const output = await this.x("buildah", ["rmi", ...this.images], { ignoreAbort: true });
        this.images.clear();

        if (output.stderr.length > 0) {
          this.logger.error("failed to remove some images", { output });
        }
      } catch (error) {
        this.logger.error("failed to clean up images", { error, images: this.images });
      }
    } else {
      this.logger.debug("no images to clean up");
    }
  }

  static async canLogin(registryHost: string) {
    try {
      await x("buildah", ["login", "--get-login", registryHost], { throwOnError: true });
      return true;
    } catch (error) {
      return false;
    }
  }

  static get tmpDir() {
    return process.env.TMPDIR ?? "/var/tmp";
  }

  static get storageRootDir() {
    return process.getuid?.() === 0
      ? "/var/lib/containers/storage"
      : `${homedir()}/.local/share/containers/storage`;
  }
}

interface CrictlOptions {
  id?: string;
  abortSignal?: AbortSignal;
}

export class Crictl {
  private id: string;
  private logger: SimpleStructuredLogger;
  private exec: Exec;

  private archives = new Set<string>();

  constructor(opts: CrictlOptions) {
    this.id = opts.id ?? randomUUID();
    this.logger = new SimpleStructuredLogger("crictl", undefined, { id: this.id });

    this.exec = new Exec({
      logger: this.logger,
      abortSignal: opts.abortSignal,
    });

    this.logger.log("initiaized", { opts });
  }

  private get x() {
    return this.exec.x.bind(this.exec);
  }

  async ps(containerName: string, quiet?: boolean) {
    return await this.x("crictl", ["ps", "--name", containerName, quiet ? "--quiet" : ""]);
  }

  async checkpoint(containerId: string, exportLocation: string) {
    const output = await this.x("crictl", [
      "checkpoint",
      `--export=${exportLocation}`,
      containerId,
    ]);
    this.archives.add(exportLocation);
    return output;
  }

  async cleanup() {
    if (this.archives.size > 0) {
      try {
        const output = await this.x("rm", ["-v", ...this.archives], { ignoreAbort: true });
        this.archives.clear();

        if (output.stderr.length > 0) {
          this.logger.error("failed to remove some archives", { output });
        }
      } catch (error) {
        this.logger.error("failed to clean up archives", { error, archives: this.archives });
      }
    } else {
      this.logger.debug("no archives to clean up");
    }
  }

  static getExportLocation(identifier: string) {
    return `${this.checkpointDir}/${identifier}.tar`;
  }

  static get checkpointDir() {
    return process.env.CRI_CHECKPOINT_DIR ?? "/checkpoints";
  }
}
