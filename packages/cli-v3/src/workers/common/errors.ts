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
  constructor(public code: number) {
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
