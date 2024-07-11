import { z } from "zod";

export class UncaughtExceptionError extends Error {
  constructor(
    public readonly originalError: { name: string; message: string; stack?: string },
    public readonly origin: "uncaughtException" | "unhandledRejection"
  ) {
    super(`Uncaught exception: ${originalError.message}`);

    this.name = "UncaughtExceptionError";
  }
}

export class TaskMetadataParseError extends Error {
  constructor(
    public readonly zodIssues: z.ZodIssue[],
    public readonly tasks: any
  ) {
    super(`Failed to parse task metadata`);

    this.name = "TaskMetadataParseError";
  }
}

export class UnexpectedExitError extends Error {
  constructor(
    public code: number,
    public signal: NodeJS.Signals | null,
    public stderr: string | undefined
  ) {
    super(`Unexpected exit with code ${code}`);

    this.name = "UnexpectedExitError";
  }
}

export class CleanupProcessError extends Error {
  constructor() {
    super("Cancelled");

    this.name = "CleanupProcessError";
  }
}

export class CancelledProcessError extends Error {
  constructor() {
    super("Cancelled");

    this.name = "CancelledProcessError";
  }
}

export class SigKillTimeoutProcessError extends Error {
  constructor() {
    super("Process kill timeout");

    this.name = "SigKillTimeoutProcessError";
  }
}

export class GracefulExitTimeoutError extends Error {
  constructor() {
    super("Graceful exit timeout");

    this.name = "GracefulExitTimeoutError";
  }
}

export function getFriendlyErrorMessage(
  code: number,
  signal: NodeJS.Signals | null,
  stderr: string | undefined,
  dockerMode = true
) {
  const message = (text: string) => {
    if (signal) {
      return `[${signal}] ${text}`;
    } else {
      return text;
    }
  };

  if (code === 137) {
    if (dockerMode) {
      return message(
        "Process ran out of memory! Try choosing a machine preset with more memory for this task."
      );
    } else {
      // Note: containerState reason and message should be checked to clarify the error
      return message(
        "Process most likely ran out of memory, but we can't be certain. Try choosing a machine preset with more memory for this task."
      );
    }
  }

  if (stderr?.includes("OOMErrorHandler")) {
    return message(
      "Process ran out of memory! Try choosing a machine preset with more memory for this task."
    );
  }

  return message(`Process exited with code ${code}.`);
}
