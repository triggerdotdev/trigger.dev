import { pathToFileURL } from "url";

export function normalizeImportPath(importPath: string): string {
  return pathToFileURL(importPath).href;
}
