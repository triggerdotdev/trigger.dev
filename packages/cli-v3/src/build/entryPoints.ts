import { BuildTarget } from "@trigger.dev/core/v3";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import * as chokidar from "chokidar";
import { glob, escapePath, isDynamicPattern } from "tinyglobby";
import { logger } from "../utilities/logger.js";
import {
  devEntryPoints,
  managedEntryPoints,
  telemetryEntryPoint,
  unmanagedEntryPoints,
} from "./packageModules.js";

type EntryPointManager = {
  entryPoints: string[];
  patterns: string[];
  ignorePatterns: string[];
  watcher?: chokidar.FSWatcher;
  stop: () => Promise<void>;
};

const DEFAULT_IGNORE_PATTERNS = [
  "**/*.test.ts",
  "**/*.test.mts",
  "**/*.test.cts",
  "**/*.test.js",
  "**/*.test.mjs",
  "**/*.test.cjs",
  "**/*.spec.ts",
  "**/*.spec.mts",
  "**/*.spec.cts",
  "**/*.spec.js",
  "**/*.spec.mjs",
  "**/*.spec.cjs",
];

const PYTHON_IGNORE_PATTERNS = [
  "**/__pycache__/**",
  "**/venv/**",
  "**/.venv/**",
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  "**/*.test.py",
  "**/*.spec.py",
  "**/test_*.py",
  "**/tests/**",
];

export async function createEntryPointManager(
  dirs: string[],
  config: ResolvedConfig,
  target: BuildTarget,
  watch: boolean,
  onEntryPointsChange?: (entryPoints: string[]) => Promise<void>
): Promise<EntryPointManager> {
  // Determine file extension patterns based on runtime
  const fileExtensions =
    config.runtime === "python"
      ? ["*.py"]
      : ["*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];

  // Patterns to match files
  const patterns = dirs.flatMap((dir) =>
    fileExtensions.map((ext) =>
      isDynamicPattern(dir) ? `${dir}/${ext}` : `${escapePath(dir)}/**/${ext}`
    )
  );

  // Patterns to ignore
  let ignorePatterns = config.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;

  // Add Python-specific ignore patterns if runtime is python
  if (config.runtime === "python") {
    ignorePatterns = ignorePatterns.concat(PYTHON_IGNORE_PATTERNS);
  }

  ignorePatterns = ignorePatterns.concat([
    "**/node_modules/**",
    "**/.git/**",
    "**/.trigger/**",
    "**/.next/**",
  ]);

  async function getEntryPoints() {
    // Get initial entry points
    const entryPoints = await glob(patterns, {
      ignore: ignorePatterns,
      absolute: false,
      cwd: config.workingDir,
    });

    if (entryPoints.length === 0) {
      return [];
    }

    // Add required entry points
    if (config.configFile) {
      entryPoints.push(config.configFile);
    }

    switch (target) {
      case "dev": {
        entryPoints.push(...devEntryPoints);
        break;
      }
      case "deploy": {
        entryPoints.push(...managedEntryPoints);
        break;
      }
      case "unmanaged": {
        entryPoints.push(...unmanagedEntryPoints);
        break;
      }
      default: {
        entryPoints.push(...managedEntryPoints);
      }
    }

    if (config.instrumentedPackageNames?.length ?? 0 > 0) {
      entryPoints.push(telemetryEntryPoint);
    }

    // Sort to ensure consistent comparison
    return entryPoints.sort();
  }

  const initialEntryPoints = await getEntryPoints();

  logger.debug("Initial entry points", {
    entryPoints: initialEntryPoints,
    patterns,
    cwd: config.workingDir,
  });

  let currentEntryPoints = initialEntryPoints;

  // Only setup watcher if watch is true
  let watcher: chokidar.FSWatcher | undefined;

  if (watch && onEntryPointsChange) {
    logger.debug("Watching entry points for changes", {
      dirs,
      cwd: config.workingDir,
      patterns,
      ignorePatterns,
    });
    // Watch the parent directories
    watcher = chokidar.watch(patterns, {
      ignored: ignorePatterns,
      persistent: true,
      ignoreInitial: true,
      useFsEvents: false,
    });

    // Handle file changes
    const updateEntryPoints = async (event: string, path: string) => {
      logger.debug("Entry point change detected", { event, path });

      const newEntryPoints = await getEntryPoints();

      // Compare arrays to see if they're different
      const hasChanged =
        newEntryPoints.length !== currentEntryPoints.length ||
        newEntryPoints.some((entry, index) => entry !== currentEntryPoints[index]);

      if (hasChanged) {
        logger.debug("Entry points changed", {
          old: currentEntryPoints,
          new: newEntryPoints,
        });
        currentEntryPoints = newEntryPoints;
        await onEntryPointsChange(newEntryPoints);
      }
    };

    watcher
      .on("add", (path) => updateEntryPoints("add", path))
      .on("addDir", (path) => updateEntryPoints("addDir", path))
      .on("unlink", (path) => updateEntryPoints("unlink", path))
      .on("unlinkDir", (path) => updateEntryPoints("unlinkDir", path))
      .on("error", (error) => logger.error("Watcher error:", error));
  }

  return {
    entryPoints: initialEntryPoints,
    watcher,
    patterns,
    ignorePatterns,
    stop: async () => {
      await watcher?.close();
    },
  };
}
