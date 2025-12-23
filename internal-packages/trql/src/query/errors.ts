// TypeScript translation of posthog/hogql/errors.py

import type { Expr } from "./ast";

export class BaseTRQLError extends Error {
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

export class ExposedTRQLError extends BaseTRQLError {
  /** An exception that can be exposed to the user. */
}

export class InternalTRQLError extends BaseTRQLError {
  /** An internal exception in the TRQL engine. */
}

export class SyntaxError extends ExposedTRQLError {
  /** The input does not conform to TRQL syntax. */
}

export class QueryError extends ExposedTRQLError {
  /** The query is invalid, though correct syntactically. */
}

export class NotImplementedError extends InternalTRQLError {
  /** This feature isn't implemented in TRQL (yet). */
}

export class ParsingError extends InternalTRQLError {
  /** Parsing failed. */
}

export class ImpossibleASTError extends InternalTRQLError {
  /** Parsing or resolution resulted in an impossible AST. */
}

export class ResolutionError extends InternalTRQLError {
  /** Resolution of a table/field/expression failed. */
}
