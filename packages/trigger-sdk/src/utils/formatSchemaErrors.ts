import type { SchemaError } from "@trigger.dev/core";
import { SchemaParserIssue } from "../types";

export function formatSchemaErrors(errors: SchemaParserIssue[]): SchemaError[] {
  return errors.map((error) => {
    const { path, message } = error;
    return { path: path.map(String), message };
  });
}
