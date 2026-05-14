import { BuildManifest } from "@trigger.dev/core/v3";
import { BuildContext } from "@trigger.dev/core/v3/build";
import {
  copyMatcherResults,
  findFilesByMatchers,
  type MatcherResult,
} from "./copyFiles.js";

export type AdditionalFilesOptions = {
  files: string[];
};

export async function addAdditionalFilesToBuild(
  source: string,
  options: AdditionalFilesOptions,
  context: BuildContext,
  manifest: BuildManifest
) {
  const matcherResults: MatcherResult[] = await findFilesByMatchers(
    options.files ?? [],
    manifest.outputPath,
    { cwd: context.workingDir }
  );

  for (const { assets, matcher } of matcherResults) {
    if (assets.length === 0) {
      context.logger.warn(`[${source}] No files found for matcher`, matcher);
    } else {
      context.logger.debug(`[${source}] Found ${assets.length} files for matcher`, matcher);
    }
  }

  await copyMatcherResults(matcherResults, (pair) => {
    context.logger.debug(`[${source}] Copying ${pair.source} to ${pair.destination}`);
  });
}
