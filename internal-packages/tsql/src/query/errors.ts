// TypeScript translation of posthog/hogql/errors.py
// Keep this file in sync with the Python version

import type { Expr } from "./ast";

export class BaseHogQLError extends Error {
  message: string;
  start?: number;
  end?: number;

  constructor(
    message: string,
    options?: {
      start?: number;
      end?: number;
      node?: Expr;
    }
  ) {
    super(message);
    this.message = message;

    if (options?.node && options.node.start !== undefined && options.node.end !== undefined) {
      this.start = options.node.start;
      this.end = options.node.end;
    } else {
      this.start = options?.start;
      this.end = options?.end;
    }
  }
}

export class ExposedHogQLError extends BaseHogQLError {
  /** An exception that can be exposed to the user. */
}

export class InternalHogQLError extends BaseHogQLError {
  /** An internal exception in the HogQL engine. */
}

export class SyntaxError extends ExposedHogQLError {
  /** The input does not conform to HogQL syntax. */
}

export class QueryError extends ExposedHogQLError {
  /** The query is invalid, though correct syntactically. */
}

export class NotImplementedError extends InternalHogQLError {
  /** This feature isn't implemented in HogQL (yet). */
}

export class ParsingError extends InternalHogQLError {
  /** Parsing failed. */
}

export class ImpossibleASTError extends InternalHogQLError {
  /** Parsing or resolution resulted in an impossible AST. */
}

export class ResolutionError extends InternalHogQLError {
  /** Resolution of a table/field/expression failed. */
}
