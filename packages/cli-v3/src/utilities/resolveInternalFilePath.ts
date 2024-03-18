import { resolve as importResolve } from "import-meta-resolve";

export function resolveInternalFilePath(filePath: string): string {
  return new URL(importResolve(filePath, import.meta.url)).href.replace("file://", "");
}
