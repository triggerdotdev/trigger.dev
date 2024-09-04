import { pathToFileURL } from "node:url";
import { isWindows } from "std-env";
//@ts-ignore - Have to ignore because TSC thinks this is ESM
export const sourceDir = isWindows
  ? pathToFileURL(__dirname).toString()
  : pathToFileURL(__dirname).toString();
