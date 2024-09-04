import { fileURLToPath } from "node:url";
import { isWindows } from "std-env";
//@ts-ignore
export const sourceDir = isWindows
  ? fileURLToPath(new URL(".", import.meta.url))
  : fileURLToPath(new URL(".", import.meta.url));
