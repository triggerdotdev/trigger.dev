import { resolve as importResolve } from "import-meta-resolve";
import { fileURLToPath } from "url";
import path from "path";

export function resolveInternalFilePath(filePath: string): string {
  return new URL(importResolve(filePath, import.meta.url)).href.replace("file://", "");
}

export function cliRootPath() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return __dirname;
}
