import { glob } from "tinyglobby";
import * as tar from "tar";
import { logger } from "../utilities/logger.js";

// The bundle dir is generated build output (bundled JS, synthesized package.json,
// build.json, Containerfile, .trigger/skills). Unlike the source-context archiver,
// it must NOT apply the usual build-output ignores (dist, build, .trigger) — those
// would strip the bundle itself. Only genuinely unwanted entries are excluded.
const BUNDLE_IGNORES = ["**/node_modules", "**/.DS_Store"];

/**
 * Archives a pre-built bundle directory (the buildWorker destination) so its
 * contents land at the archive root — the build server extracts without
 * stripping path components.
 */
export async function createBundleArchive(bundleDir: string, outputPath: string) {
  logger.debug("Creating bundle archive", { bundleDir, outputPath });

  const files = await glob(["**/*"], {
    cwd: bundleDir,
    ignore: BUNDLE_IGNORES,
    dot: true, // .trigger/skills and .dockerignore must be included
    absolute: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  if (files.length === 0) {
    throw new Error("No files found in the bundle output. This is likely a bug.");
  }

  await tar.create(
    {
      gzip: true,
      file: outputPath,
      cwd: bundleDir,
      portable: true,
      preservePaths: false,
      mtime: new Date(0),
    },
    files
  );

  logger.debug("Bundle archive created", { outputPath, fileCount: files.length });
}
