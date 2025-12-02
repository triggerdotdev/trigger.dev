import { BuildManifest } from "@trigger.dev/core/v3/schemas";
import { cp, link, mkdir, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utilities/logger.js";

export async function copyManifestToDir(
  manifest: BuildManifest,
  source: string,
  destination: string,
  storeDir?: string
): Promise<BuildManifest> {
  // Copy the dir from source to destination
  // If storeDir is provided, create hardlinks for files that exist in the store
  if (storeDir) {
    await copyDirWithStore(source, destination, storeDir, manifest.outputHashes);
  } else {
    await cp(source, destination, { recursive: true });
  }

  logger.debug("Copied manifest to dir", { source, destination, storeDir });

  // Then update the manifest to point to the new workerDir
  const updatedManifest = { ...manifest };

  updatedManifest.configPath = updatedManifest.configPath.replace(source, destination);
  updatedManifest.loaderEntryPoint = updatedManifest.loaderEntryPoint?.replace(source, destination);
  updatedManifest.runWorkerEntryPoint = updatedManifest.runWorkerEntryPoint.replace(
    source,
    destination
  );
  updatedManifest.indexWorkerEntryPoint = updatedManifest.indexWorkerEntryPoint.replace(
    source,
    destination
  );

  updatedManifest.files = updatedManifest.files.map((file) => {
    return {
      ...file,
      out: file.out.replace(source, destination),
    };
  });

  updatedManifest.outputPath = destination;

  return updatedManifest;
}

/**
 * Sanitizes a hash to be safe for use as a filename.
 * esbuild's hashes are base64-encoded and may contain `/` and `+` characters.
 */
function sanitizeHashForFilename(hash: string): string {
  return hash.replace(/\//g, "_").replace(/\+/g, "-");
}

/**
 * Computes a hash of file contents to use as content-addressable key.
 * This is a fallback for when outputHashes is not available.
 */
async function computeFileHash(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

/**
 * Recursively copies a directory, using hardlinks for files that exist in the store.
 * This preserves disk space savings from the content-addressable store.
 *
 * @param source - Source directory path
 * @param destination - Destination directory path
 * @param storeDir - Content-addressable store directory
 * @param outputHashes - Optional map of file paths to their content hashes (from BuildManifest)
 */
async function copyDirWithStore(
  source: string,
  destination: string,
  storeDir: string,
  outputHashes?: Record<string, string>
): Promise<void> {
  await mkdir(destination, { recursive: true });

  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destPath = join(destination, entry.name);

    if (entry.isDirectory()) {
      // Recursively copy subdirectories
      await copyDirWithStore(sourcePath, destPath, storeDir, outputHashes);
    } else if (entry.isFile()) {
      // Try to get hash from manifest first, otherwise compute it
      const contentHash = outputHashes?.[sourcePath] ?? (await computeFileHash(sourcePath));
      // Sanitize hash to be filesystem-safe (base64 can contain / and +)
      const safeHash = sanitizeHashForFilename(contentHash);
      const storePath = join(storeDir, safeHash);

      if (existsSync(storePath)) {
        // Create hardlink to store file
        await link(storePath, destPath);
      } else {
        // File wasn't in the store - copy normally
        await cp(sourcePath, destPath);
      }
    } else if (entry.isSymbolicLink()) {
      // Preserve symbolic links (e.g., node_modules links)
      await cp(sourcePath, destPath, { verbatimSymlinks: true });
    }
  }
}
