export type NormalizedRuntime = "node" | "bun";

export interface ParsedRuntime {
  /** The normalized runtime type */
  runtime: NormalizedRuntime;
  /** The original runtime string */
  originalRuntime: string;
  /** The display name for the runtime */
  displayName: string;
}

/**
 * Parses a runtime string and returns normalized runtime information
 */
export function parseRuntime(runtime: string | null | undefined): ParsedRuntime | null {
  if (!runtime) {
    return null;
  }

  // Normalize runtime strings
  let normalizedRuntime: NormalizedRuntime;
  let displayName: string;

  if (runtime.startsWith("bun")) {
    normalizedRuntime = "bun";
    displayName = "Bun";
  } else if (runtime.startsWith("node")) {
    normalizedRuntime = "node";
    displayName = "Node.js";
  } else {
    return null;
  }

  return {
    runtime: normalizedRuntime,
    originalRuntime: runtime,
    displayName,
  };
}

/**
 * Formats runtime with version for display
 */
export function formatRuntimeWithVersion(
  runtime: string | null | undefined,
  version: string | null | undefined
): string {
  const parsed = parseRuntime(runtime);
  if (!parsed) {
    return "Unknown runtime";
  }

  if (version) {
    return `${parsed.displayName} v${version}`;
  }

  return parsed.displayName;
}
