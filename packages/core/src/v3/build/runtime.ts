import { join } from "node:path";
import { BuildRuntime } from "../schemas/build.js";

export const DEFAULT_RUNTIME: BuildRuntime = "node";

export function binaryForRuntime(runtime: BuildRuntime): string {
  switch (runtime) {
    case "node":
      return "node";
    case "bun":
      return "bun";
    default:
      throw new Error(`Unsupported runtime ${runtime}`);
  }
}

export function execPathForRuntime(runtime: BuildRuntime): string {
  switch (runtime) {
    case "node":
      return process.execPath;
    case "bun":
      if (typeof process.env.BUN_INSTALL === "string") {
        return join(process.env.BUN_INSTALL, "bin", "bun");
      }

      return join("~", ".bin", "bin", "bun");
    default:
      throw new Error(`Unsupported runtime ${runtime}`);
  }
}
