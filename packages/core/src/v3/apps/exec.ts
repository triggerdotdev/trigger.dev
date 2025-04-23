import { SimpleStructuredLogger } from "../utils/structuredLogger.js";
import { type Output, type Result, x } from "tinyexec";

export class ExecResult {
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

export interface ExecOptions {
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
  ): Promise<Output> {
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
      throw new ExecResult(result);
    }

    if (result.killed) {
      this.logger.error(`killed: ${commandWithFirstArg}`, metadata);
      throw new ExecResult(result);
    }

    if (result.exitCode !== 0) {
      this.logger.error(`non-zero exit: ${commandWithFirstArg}`, metadata);
      throw new ExecResult(result);
    }

    return output;
  }

  static Result = ExecResult;
}

export { type Output };
