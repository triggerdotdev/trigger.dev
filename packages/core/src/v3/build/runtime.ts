import { join } from "node:path";
import { BuildManifest, BuildRuntime } from "../schemas/build.js";

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

      if (typeof process.env.BUN_INSTALL_BIN === "string") {
        return join(process.env.BUN_INSTALL_BIN, "bun");
      }

      return join("~", ".bin", "bin", "bun");
    default:
      throw new Error(`Unsupported runtime ${runtime}`);
  }
}

export type ExecOptions = {
  loaderEntryPoint?: string;
  customConditions?: string[];
};

export function execOptionsForRuntime(runtime: BuildRuntime, options: ExecOptions): string {
  switch (runtime) {
    case "node": {
      const importEntryPoint = options.loaderEntryPoint
        ? `--import=${options.loaderEntryPoint}`
        : undefined;

      const conditions = options.customConditions?.map((condition) => `--conditions=${condition}`);

      return [importEntryPoint, conditions, process.env.NODE_OPTIONS]
        .filter(Boolean)
        .flat()
        .join(" ");
    }
    case "bun": {
      return "";
    }
  }
}
