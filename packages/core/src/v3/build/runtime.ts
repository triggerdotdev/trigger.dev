import { BuildRuntime } from "../schemas/build.js";

export const DEFAULT_RUNTIME: BuildRuntime = "node20";

export function binaryForRuntime(runtime: BuildRuntime): string {
  switch (runtime) {
    case "node20":
      return "node";
    case "bun":
      return "bun";
    default:
      throw new Error(`Unsupported runtime ${runtime}`);
  }
}