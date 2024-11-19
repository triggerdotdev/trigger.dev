import { pathToFileURL } from "node:url";
//@ts-ignore - Have to ignore because TSC thinks this is ESM
export const sourceDir = pathToFileURL(__dirname).toString();
