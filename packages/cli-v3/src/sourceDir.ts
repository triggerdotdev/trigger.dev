import { fileURLToPath } from "node:url";
//@ts-ignore
export const sourceDir = fileURLToPath(new URL(".", import.meta.url));
