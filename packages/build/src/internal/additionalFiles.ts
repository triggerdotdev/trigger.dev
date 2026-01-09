import { BuildManifest } from "@trigger.dev/core/v3";
import { BuildContext } from "@trigger.dev/core/v3/build";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { glob } from "tinyglobby";

export type AdditionalFilesOptions = {
  files: string[];
  /**
   * Optional destination directory for the matched files.
   *
   * When specified, files will be placed under this directory while preserving
   * their structure relative to the glob pattern's base directory.
   *
   * This is useful when including files from parent directories (using `..` in the glob pattern),
   * as the default behavior strips `..` segments which can result in unexpected destination paths.
   *
   * @example
   * // In a monorepo with structure: apps/trigger, apps/shared
   * // From apps/trigger/trigger.config.ts:
   * additionalFiles({
   *   files: ["../shared/**"],
   *   destination: "apps/shared"
   * })
   * // Files from ../shared/utils.ts will be copied to apps/shared/utils.ts
   */
  destination?: string;
};

export async function addAdditionalFilesToBuild(
  source: string,
  options: AdditionalFilesOptions,
  context: BuildContext,
  manifest: BuildManifest
) {
  // Copy any static assets to the destination
  const staticAssets = await findStaticAssetFiles(options.files ?? [], manifest.outputPath, {
    cwd: context.workingDir,
    destination: options.destination,
  });

  for (const { assets, matcher } of staticAssets) {
    if (assets.length === 0) {
      context.logger.warn(`[${source}] No files found for matcher`, matcher);
    } else {
      context.logger.debug(`[${source}] Found ${assets.length} files for matcher`, matcher);
    }
  }

  await copyStaticAssets(staticAssets, source, context);
}

type MatchedStaticAssets = { source: string; destination: string }[];

type FoundStaticAssetFiles = Array<{
  matcher: string;
  assets: MatchedStaticAssets;
}>;

async function findStaticAssetFiles(
  matchers: string[],
  destinationPath: string,
  options?: { cwd?: string; ignore?: string[]; destination?: string }
): Promise<FoundStaticAssetFiles> {
  const result: FoundStaticAssetFiles = [];

  for (const matcher of matchers) {
    const assets = await findStaticAssetsForMatcher(matcher, destinationPath, options);

    result.push({ matcher, assets });
  }

  return result;
}

// Extracts the base directory from a glob pattern (the non-wildcard prefix).
// For example: "../shared/**" -> "../shared", "./assets/*.txt" -> "./assets"
// For specific files without globs: "./config/settings.json" -> "./config" (parent dir)
// For single-part patterns: "file.txt" -> "." (current dir)
export function getGlobBase(pattern: string): string {
  const parts = pattern.split(/[/\\]/);
  const baseParts: string[] = [];
  let hasGlobCharacters = false;

  for (const part of parts) {
    // Stop at the first part that contains glob characters
    if (part.includes("*") || part.includes("?") || part.includes("[") || part.includes("{")) {
      hasGlobCharacters = true;
      break;
    }
    baseParts.push(part);
  }

  // If no glob characters were found, the pattern is a specific file path.
  // Return the parent directory so that relative() preserves the filename.
  // For single-part patterns (just a filename), return "." to indicate current directory.
  if (!hasGlobCharacters) {
    baseParts.pop(); // Remove the filename, keep the directory (or empty for single-part)
  }

  return baseParts.length > 0 ? baseParts.join(posix.sep) : ".";
}

async function findStaticAssetsForMatcher(
  matcher: string,
  destinationPath: string,
  options?: { cwd?: string; ignore?: string[]; destination?: string }
): Promise<MatchedStaticAssets> {
  const result: MatchedStaticAssets = [];

  const files = await glob({
    patterns: [matcher],
    cwd: options?.cwd,
    ignore: options?.ignore ?? [],
    onlyFiles: true,
    absolute: true,
  });

  const cwd = options?.cwd ?? process.cwd();

  for (const file of files) {
    let pathInsideDestinationDir: string;

    if (options?.destination) {
      // When destination is specified, compute path relative to the glob pattern's base directory
      const globBase = getGlobBase(matcher);
      const absoluteGlobBase = isAbsolute(globBase) ? globBase : resolve(cwd, globBase);
      const relativeToGlobBase = relative(absoluteGlobBase, file);

      // Place files under the specified destination directory
      pathInsideDestinationDir = join(options.destination, relativeToGlobBase);
    } else {
      // Default behavior: compute relative path from cwd and strip ".." segments
      // Use platform-specific separator for splitting since path.relative() returns platform separators
      pathInsideDestinationDir = relative(cwd, file)
        .split(sep)
        .filter((p) => p !== "..")
        .join(posix.sep);
    }

    const relativeDestinationPath = join(destinationPath, pathInsideDestinationDir);

    result.push({
      source: file,
      destination: relativeDestinationPath,
    });
  }

  return result;
}

async function copyStaticAssets(
  staticAssetFiles: FoundStaticAssetFiles,
  sourceName: string,
  context: BuildContext
): Promise<void> {
  for (const { assets } of staticAssetFiles) {
    for (const { source, destination } of assets) {
      await mkdir(dirname(destination), { recursive: true });

      context.logger.debug(`[${sourceName}] Copying ${source} to ${destination}`);

      await copyFile(source, destination);
    }
  }
}
