import { join } from "node:path";
import { pathToFileURL } from "url";
import { BuildRuntime } from "../schemas/build.js";
import { dedupFlags } from "./flags.js";
import { homedir } from "node:os";

export const DEFAULT_RUNTIME = "node" satisfies BuildRuntime;

export function binaryForRuntime(runtime: BuildRuntime): string {
  switch (runtime) {
    case "node":
    case "node-22":
      return "node";
    case "bun":
      return "bun";
    case "python":
      return "python3";
    default:
      throw new Error(`Unsupported runtime ${runtime}`);
  }
}

export function execPathForRuntime(runtime: BuildRuntime): string {
  switch (runtime) {
    case "node":
    case "node-22":
      return process.execPath;
    case "bun":
      if (typeof process.env.BUN_INSTALL === "string") {
        return join(process.env.BUN_INSTALL, "bin", "bun");
      }

      if (typeof process.env.BUN_INSTALL_BIN === "string") {
        return join(process.env.BUN_INSTALL_BIN, "bun");
      }

      return join(homedir(), ".bun", "bin", "bun");
    case "python":
      return "python3";
    default:
      throw new Error(`Unsupported runtime ${runtime}`);
  }
}

export type ExecOptions = {
  loaderEntryPoint?: string;
  customConditions?: string[];
};

export function execOptionsForRuntime(
  runtime: BuildRuntime,
  options: ExecOptions,
  additionalNodeOptions?: string
): string {
  switch (runtime) {
    case "node":
    case "node-22": {
      const importEntryPoint = options.loaderEntryPoint
        ? `--import=${pathToFileURL(options.loaderEntryPoint).href}`
        : undefined;

      const conditions = options.customConditions?.map((condition) => `--conditions=${condition}`);

      //later flags will win (after the dedupe)
      const flags = [
        process.env.NODE_OPTIONS,
        additionalNodeOptions,
        importEntryPoint,
        conditions,
        nodeRuntimeNeedsGlobalWebCryptoFlag() ? "--experimental-global-webcrypto" : undefined,
      ]
        .filter(Boolean)
        .flat()
        .join(" ");

      return dedupFlags(flags);
    }
    case "bun": {
      return "";
    }
    case "python": {
      // CRITICAL: -u flag ensures unbuffered stdout for line-delimited JSON IPC
      return "-u";
    }
  }
}

// Detect if we are using node v18, since we don't support lower than 18, and we only need to enable the flag for v18
function nodeRuntimeNeedsGlobalWebCryptoFlag(): boolean {
  try {
    return process.versions.node.startsWith("18.");
  } catch {
    return false;
  }
}

export function detectRuntimeVersion(): string | undefined {
  try {
    // Check if we're running under Bun
    const isBun = typeof process.versions.bun === "string";

    if (isBun) {
      return process.versions.bun;
    }

    // Otherwise, return Node.js version
    return process.versions.node;
  } catch {
    return undefined;
  }
}
