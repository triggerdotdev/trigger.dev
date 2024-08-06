import { pathToFileURL } from "node:url";
//@ts-ignore - Have to ignore because TSC thinks this is ESM
export const packageDir = pathToFileURL(__dirname).pathname;
