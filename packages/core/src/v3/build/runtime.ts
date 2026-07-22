import { join } from "node:path";
import { pathToFileURL } from "url";
import { BuildRuntime, ConfigRuntime } from "../schemas/build.js";
import { dedupFlags } from "./flags.js";
import { homedir } from "node:os";

export const DEFAULT_RUNTIME = "node" satisfies BuildRuntime;

export type DeprecatedConfigRuntime = "experimental-node-24" | "experimental-node-26";

export function isDeprecatedConfigRuntime(runtime: unknown): runtime is DeprecatedConfigRuntime {
  return runtime === "experimental-node-24" || runtime === "experimental-node-26";
}

/** Maps a deprecated runtime alias to the runtime that should be used instead. */
export function deprecatedRuntimeReplacement(runtime: DeprecatedConfigRuntime): BuildRuntime {
  switch (runtime) {
    case "experimental-node-24":
      return "node-24";
    case "experimental-node-26":
      return "node-26";
  }
}

/** @deprecated Renamed to {@link DeprecatedConfigRuntime}. */
export type ExperimentalConfigRuntime = DeprecatedConfigRuntime;

/** @deprecated Renamed to {@link isDeprecatedConfigRuntime}. */
export const isExperimentalConfigRuntime = isDeprecatedConfigRuntime;

export function resolveBuildRuntime(runtime: unknown): BuildRuntime {
  const parsedRuntime = ConfigRuntime.safeParse(runtime);

  if (!parsedRuntime.success) {
    const value = typeof runtime === "string" ? `"${runtime}"` : String(runtime);

    throw new Error(
      `Unsupported runtime ${value} in trigger.config. Supported runtimes: ${ConfigRuntime.options.join(
        ", "
      )}.`
    );
  }

  switch (parsedRuntime.data) {
    case "experimental-node-24":
      return "node-24";
    case "experimental-node-26":
      return "node-26";
    default:
      return parsedRuntime.data;
  }
}

export function binaryForRuntime(runtime: BuildRuntime): string {
  switch (runtime) {
    case "node":
    case "node-22":
    case "node-24":
    case "node-26":
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
    case "node-22":
    case "node-24":
    case "node-26":
      return process.execPath;
    case "bun":
      if (typeof process.env.BUN_INSTALL === "string") {
        return join(process.env.BUN_INSTALL, "bin", "bun");
      }

      if (typeof process.env.BUN_INSTALL_BIN === "string") {
        return join(process.env.BUN_INSTALL_BIN, "bun");
      }

      return join(homedir(), ".bun", "bin", "bun");
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
    case "node-22":
    case "node-24":
    case "node-26": {
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
