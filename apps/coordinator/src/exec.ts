import { SimpleLogger } from "@trigger.dev/core/v3/apps";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { type Result, x } from "tinyexec";

class TinyResult {
  constructor(private result: Result) {}

  get pid() {
    return this.result.pid;
  }

  get process() {
    return this.result.process;
  }

  get exitCode() {
    return this.result.exitCode;
  }

  get aborted() {
    return this.result.aborted;
  }

  get killed() {
    return this.result.killed;
  }
}

interface ExecOptions {
  logger?: SimpleLogger;
  abortSignal?: AbortSignal;
  logOutput?: boolean;
}

export class Exec {
  private logger: SimpleLogger;
  private abortSignal: AbortSignal | undefined;
  private logOutput: boolean;

  constructor(opts: ExecOptions) {
    this.logger = opts.logger ?? new SimpleLogger();

    if (opts.abortSignal) {
      this.abortSignal = opts.abortSignal;
      this.abortSignal.addEventListener("abort", () => {
        this.logger.error("abort signal triggered");
      });
    }

    this.logOutput = opts.logOutput ?? false;
  }

  async x(command: string, args?: string[], opts?: { neverThrow?: boolean; trimArgs?: boolean }) {
    const argsTrimmed = opts?.trimArgs === true ? args?.map((arg) => arg.trim()) : args;

    const commandWithFirstArg = `${command}${argsTrimmed?.length ? ` ${argsTrimmed[0]}` : ""}`;
    this.logger.debug(`exec: ${commandWithFirstArg}`, { command, args, argsTrimmed });

    const result = x(command, argsTrimmed, {
      signal: this.abortSignal,
      // We don't use this as it doesn't cover killed and aborted processes
      // throwOnError: true,
    });

    const output = await result;

    if (this.logOutput) {
      this.logger.debug(`output: ${commandWithFirstArg}`, { command, args, argsTrimmed, output });
    }

    if (opts?.neverThrow) {
      return output;
    }

    if (result.aborted) {
      this.logger.error(`aborted: ${commandWithFirstArg}`, { command, args, argsTrimmed, output });
      throw new TinyResult(result);
    }

    if (result.killed) {
      this.logger.error(`killed: ${commandWithFirstArg}`, { command, args, argsTrimmed, output });
      throw new TinyResult(result);
    }

    if (result.exitCode !== 0) {
      this.logger.error(`non-zero exit: ${commandWithFirstArg}`, {
        command,
        args,
        argsTrimmed,
        output,
      });
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
  private logger: SimpleLogger;
  private exec: Exec;

  private containers = new Set<string>();
  private images = new Set<string>();

  constructor(opts: BuildahOptions) {
    this.id = opts.id ?? randomUUID();
    this.logger = new SimpleLogger(`[buildah][${this.id}]`);

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
        const output = await this.x("buildah", ["rm", ...this.containers]);
        this.containers.clear();

        if (output.stderr.length > 0) {
          this.logger.error("failed to remove some containers", { output });
        }
      } catch (error) {
        this.logger.error("failed to clean up containers", { error, containers: this.containers });
      }
    }

    if (this.images.size > 0) {
      try {
        const output = await this.x("buildah", ["rmi", ...this.images]);
        this.images.clear();

        if (output.stderr.length > 0) {
          this.logger.error("failed to remove some images", { output });
        }
      } catch (error) {
        this.logger.error("failed to clean up images", { error, images: this.images });
      }
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
  private logger: SimpleLogger;
  private exec: Exec;

  private archives = new Set<string>();

  constructor(opts: CrictlOptions) {
    this.id = opts.id ?? randomUUID();
    this.logger = new SimpleLogger(`[crictl][${this.id}]`);

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
    return this.x("crictl", ["ps", "--name", containerName, quiet ? "--quiet" : ""]);
  }

  async checkpoint(containerId: string, exportLocation: string) {
    await this.x("crictl", ["checkpoint", `--export=${exportLocation}`, containerId]);
  }

  async cleanup() {
    if (this.archives.size > 0) {
      try {
        const output = await this.x("rm", ["-v", ...this.archives]);
        this.archives.clear();

        if (output.stderr.length > 0) {
          this.logger.error("failed to remove some archives", { output });
        }
      } catch (error) {
        this.logger.error("failed to clean up archives", { error, archives: this.archives });
      }
    }
  }
}
