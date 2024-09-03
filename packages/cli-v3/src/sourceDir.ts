import { fileURLToPath } from "node:url";
import { isWindows } from "std-env";
//@ts-ignore
export const sourceDir = isWindows
  ? new URL(".", import.meta.url).href
  : fileURLToPath(new URL(".", import.meta.url));
