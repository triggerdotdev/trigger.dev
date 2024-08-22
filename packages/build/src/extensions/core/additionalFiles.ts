import { relative, join, posix, dirname } from "node:path";
import { glob } from "tinyglobby";
import { copyFile, mkdir } from "node:fs/promises";
import { BuildExtension } from "@trigger.dev/core/v3/build";

export type AdditionalFilesOptions = {
  files: string[];
};

export function additionalFiles(options: AdditionalFilesOptions): BuildExtension {
  return {
    name: "additionalFiles",
    async onBuildComplete(context, manifest) {
      // Copy any static assets to the destination
      const staticAssets = await findStaticAssetFiles(options.files ?? [], manifest.outputPath, {
        cwd: context.workingDir,
      });

      for (const { assets, matcher } of staticAssets) {
        if (assets.length === 0) {
          console.warn("No files found for matcher", matcher);
        }
      }

      await copyStaticAssets(staticAssets);
    },
  };
}

type MatchedStaticAssets = { source: string; destination: string }[];

type FoundStaticAssetFiles = Array<{
  matcher: string;
  assets: MatchedStaticAssets;
}>;

async function findStaticAssetFiles(
  matchers: string[],
  destinationPath: string,
  options?: { cwd?: string; ignore?: string[] }
): Promise<FoundStaticAssetFiles> {
  const result: FoundStaticAssetFiles = [];

  for (const matcher of matchers) {
    const assets = await findStaticAssetsForMatcher(matcher, destinationPath, options);

    result.push({ matcher, assets });
  }

  return result;
}

async function findStaticAssetsForMatcher(
  matcher: string,
  destinationPath: string,
  options?: { cwd?: string; ignore?: string[] }
): Promise<MatchedStaticAssets> {
  const result: MatchedStaticAssets = [];

  const files = await glob({
    patterns: [matcher],
    cwd: options?.cwd,
    ignore: options?.ignore ?? [],
    onlyFiles: true,
    absolute: true,
  });

  let matches = 0;

  for (const file of files) {
    matches++;

    const pathInsideDestinationDir = relative(options?.cwd ?? process.cwd(), file)
      .split(posix.sep)
      .filter((p) => p !== "..")
      .join(posix.sep);

    const relativeDestinationPath = join(destinationPath, pathInsideDestinationDir);

    result.push({
      source: file,
      destination: relativeDestinationPath,
    });
  }

  return result;
}

async function copyStaticAssets(staticAssetFiles: FoundStaticAssetFiles): Promise<void> {
  for (const { assets } of staticAssetFiles) {
    for (const { source, destination } of assets) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
  }
}
