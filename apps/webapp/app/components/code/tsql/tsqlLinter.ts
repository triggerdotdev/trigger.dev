import type { EditorView } from "@codemirror/view";
import type { Diagnostic } from "@codemirror/lint";
import type { TableSchema } from "@internal/tsql";
import { parseTSQLSelect, SyntaxError, QueryError } from "@internal/tsql";

/**
 * Configuration for the TSQL linter
 */
export interface TSQLLinterConfig {
  /** Optional schema for validating table/column names */
  schema?: TableSchema[];
  /** Delay in milliseconds before running the linter (debouncing) */
  delay?: number;
}

/**
 * Extract line and column from a TSQL error message
 * Error format: "Syntax error at line X:Y: message"
 */
function parseErrorPosition(message: string): { line: number; column: number } | null {
  const match = message.match(/at line (\d+):(\d+)/);
  if (match) {
    return {
      line: parseInt(match[1], 10),
      column: parseInt(match[2], 10),
    };
  }
  return null;
}

/**
 * Convert line/column to a document position
 */
function positionToOffset(
  doc: string,
  line: number,
  column: number
): number {
  const lines = doc.split("\n");

  // line is 1-indexed
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }

  return offset + column;
}

/**
 * Find the end of a word/token at the given position
 */
function findTokenEnd(doc: string, start: number): number {
  let end = start;

  // Scan forward until we hit whitespace or end of string
  while (end < doc.length && /\S/.test(doc[end])) {
    end++;
  }

  // If we didn't move, include at least one character
  if (end === start) {
    end = Math.min(start + 1, doc.length);
  }

  return end;
}

/**
 * Create a TSQL linter function for CodeMirror
 *
 * This linter uses the TSQL ANTLR parser to detect syntax errors
 * and optionally validates against a schema.
 *
 * @param config - Linter configuration
 * @returns A linter function for use with CodeMirror's linter extension
 */
export function createTSQLLinter(
  config: TSQLLinterConfig = {}
): (view: EditorView) => Diagnostic[] {
  return (view: EditorView): Diagnostic[] => {
    const content = view.state.doc.toString().trim();

    // Return no errors for empty content
    if (!content) {
      return [];
    }

    const diagnostics: Diagnostic[] = [];

    try {
      // Try to parse the query
      parseTSQLSelect(content);

      // If parsing succeeds, we could do additional schema validation here
      // For now, we just validate syntax
    } catch (error) {
      if (error instanceof SyntaxError) {
        const position = parseErrorPosition(error.message);

        let from: number;
        let to: number;

        if (position) {
          from = positionToOffset(content, position.line, position.column);
          to = findTokenEnd(content, from);
        } else {
          // If we can't parse the position, highlight the whole query
          from = 0;
          to = content.length;
        }

        // Clean up the error message
        let message = error.message;
        // Remove the "Syntax error at line X:Y: " prefix if present
        message = message.replace(/^Syntax error at line \d+:\d+:\s*/, "");

        diagnostics.push({
          from,
          to,
          severity: "error",
          message: message,
          source: "tsql",
        });
      } else if (error instanceof QueryError) {
        // Schema validation errors don't have position info,
        // so highlight the whole query
        diagnostics.push({
          from: 0,
          to: content.length,
          severity: "warning",
          message: error.message,
          source: "tsql",
        });
      } else if (error instanceof Error) {
        // Unknown error
        diagnostics.push({
          from: 0,
          to: content.length,
          severity: "error",
          message: error.message,
          source: "tsql",
        });
      }
    }

    return diagnostics;
  };
}

/**
 * Check if a TSQL query is valid
 *
 * @param query - The query to validate
 * @returns true if the query is valid, false otherwise
 */
export function isValidTSQLQuery(query: string): boolean {
  if (!query.trim()) {
    return true; // Empty queries are considered valid
  }

  try {
    parseTSQLSelect(query);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get error message for a TSQL query, if any
 *
 * @param query - The query to validate
 * @returns Error message if invalid, null if valid
 */
export function getTSQLError(query: string): string | null {
  if (!query.trim()) {
    return null;
  }

  try {
    parseTSQLSelect(query);
    return null;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    return "Unknown error";
  }
}

