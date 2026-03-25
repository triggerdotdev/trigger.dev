// TypeScript translation of posthog/hogql/errors.py

import type { Expr } from "./ast";

export class BaseTSQLError extends Error {
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

export class ExposedTSQLError extends BaseTSQLError {
  /** An exception that can be exposed to the user. */
}

export class InternalTSQLError extends BaseTSQLError {
  /** An internal exception in the TSQL engine. */
}

export class SyntaxError extends ExposedTSQLError {
  /** The input does not conform to TSQL syntax. */
}

export class QueryError extends ExposedTSQLError {
  /** The query is invalid, though correct syntactically. */
}

export class NotImplementedError extends InternalTSQLError {
  /** This feature isn't implemented in TSQL (yet). */
}

export class ParsingError extends InternalTSQLError {
  /** Parsing failed. */
}

export class ImpossibleASTError extends InternalTSQLError {
  /** Parsing or resolution resulted in an impossible AST. */
}

export class ResolutionError extends InternalTSQLError {
  /** Resolution of a table/field/expression failed. */
}
