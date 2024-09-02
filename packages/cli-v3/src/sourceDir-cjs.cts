import { pathToFileURL, fileURLToPath } from "node:url";
//@ts-ignore - Have to ignore because TSC thinks this is ESM
export const sourceDir = fileURLToPath(pathToFileURL(__dirname));
