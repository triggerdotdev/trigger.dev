import path from "node:path";
import { fileURLToPath } from "node:url";

export function cliRootPath() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return __dirname;
}
