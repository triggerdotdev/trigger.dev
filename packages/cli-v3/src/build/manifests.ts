import { BuildManifest } from "@trigger.dev/core/v3/schemas";
import { cp } from "node:fs/promises";
import { logger } from "../utilities/logger.js";

export async function copyManifestToDir(manifest: BuildManifest, source: string, destination: string): Promise<BuildManifest> {
  // Copy the dir in destination to workerDir
  await cp(source, destination, { recursive: true });

  logger.debug("Copied manifest to dir", { source, destination });
  
  // Then update the manifest to point to the new workerDir
  const updatedManifest = { ...manifest };

  updatedManifest.configPath = updatedManifest.configPath.replace(source, destination);
  updatedManifest.loaderPath = updatedManifest.loaderPath?.replace(source, destination);
  updatedManifest.workerEntryPath = updatedManifest.workerEntryPath?.replace(source, destination);
  updatedManifest.workerForkPath = updatedManifest.workerForkPath?.replace(source, destination);

  updatedManifest.files = updatedManifest.files.map((file) => {
    return {
      ...file,
      out: file.out.replace(source, destination),
    };
  });

  updatedManifest.outputPath = destination;

  return updatedManifest;
}