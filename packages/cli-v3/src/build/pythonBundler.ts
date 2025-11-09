/**
 * Python bundler - copies Python files and generates build manifest.
 *
 * Unlike Node.js which uses esbuild, Python files are copied as-is.
 */

import path from "path";
import { readFile, copyFile, mkdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { BuildManifest, BuildTarget } from "@trigger.dev/core/v3";
import type { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { logger } from "../utilities/logger.js";
import { parseRequirementsTxt } from "./pythonDependencies.js";
import { VERSION } from "../version.js";
import { CORE_VERSION } from "@trigger.dev/core/v3";
import { sourceDir } from "../sourceDir.js";

export interface PythonBundleOptions {
  entryPoints: string[]; // Absolute paths to Python files
  outputDir: string; // Build output directory
  projectDir: string; // Project root
  requirementsFile?: string; // Optional path to requirements.txt
  config: ResolvedConfig; // Resolved config
  target: BuildTarget; // dev, deploy, or unmanaged
}

export interface PythonBundleResult {
  entries: Array<{
    entry: string; // Absolute path to input file
    out: string; // Relative path to output file
    relativePath: string; // Relative path from project dir
    content: string; // File content
    contentHash: string; // Content hash
  }>;
  requirementsContent?: string;
}

/**
 * Bundle Python tasks by copying files and generating manifest.
 * Returns data needed to create BuildManifest.
 */
export async function bundlePython(options: PythonBundleOptions): Promise<PythonBundleResult> {
  const { entryPoints, outputDir, projectDir, requirementsFile, config, target } = options;

  logger.info("Bundling Python tasks", {
    entryPoints: entryPoints.length,
    outputDir,
    projectDir,
  });

  // Create output directory
  await mkdir(outputDir, { recursive: true });

  // Copy Python files to output
  const entries: PythonBundleResult["entries"] = [];

  for (const entryPoint of entryPoints) {
    if (entryPoint.endsWith(".py")) {
      const relativePath = path.relative(projectDir, entryPoint);
      const outputPath = path.join(outputDir, relativePath);

      // Ensure output directory exists
      await mkdir(path.dirname(outputPath), { recursive: true });

      // Read file content
      const content = await readFile(entryPoint, "utf-8");

      // Copy file
      await copyFile(entryPoint, outputPath);

      // Calculate content hash
      const contentHash = createHash("md5").update(content).digest("hex");

      logger.debug("Copied Python task file", {
        from: entryPoint,
        to: outputPath,
        relativePath,
        size: content.length,
      });

      entries.push({
        entry: entryPoint,
        out: outputPath,
        relativePath,
        content,
        contentHash,
      });
    }
  }

  // Read requirements.txt if provided or look for default
  let requirementsContent: string | undefined;
  const reqPath = requirementsFile || path.join(projectDir, "requirements.txt");

  try {
    await access(reqPath);
    requirementsContent = await readFile(reqPath, "utf-8");

    // Copy requirements.txt to output
    await copyFile(reqPath, path.join(outputDir, "requirements.txt"));

    logger.info("Copied requirements.txt", {
      path: reqPath,
      dependencies: parseRequirementsTxt(requirementsContent).length,
    });
  } catch {
    logger.warn("No requirements.txt found, Python tasks may have missing dependencies");
  }

  const result: PythonBundleResult = {
    entries,
    requirementsContent,
  };

  logger.info("Python bundle complete", {
    files: entries.length,
    requirements: requirementsContent ? parseRequirementsTxt(requirementsContent).length : 0,
    outputDir,
  });

  return result;
}

/**
 * Generate BuildManifest from bundle result.
 */
export async function createBuildManifestFromPythonBundle(
  bundle: PythonBundleResult,
  options: Pick<PythonBundleOptions, "outputDir" | "config" | "target">
): Promise<BuildManifest> {
  const { outputDir, config, target } = options;

  // Create config manifest (same as Node.js projects)
  const configManifest = {
    project: config.project,
    dirs: config.dirs,
  };

  // TODO: Get environment from CLI options (like Node.js build does)
  const environment = config.deploy?.env?.ENVIRONMENT ?? "development";
  // TODO: Get branch from git or CLI options
  const branch = undefined;
  // TODO: Get sdkVersion from CLI or package.json
  const sdkVersion = CORE_VERSION;

  // Calculate overall content hash from all file hashes
  const hasher = createHash("md5");
  for (const entry of bundle.entries) {
    hasher.update(entry.contentHash);
  }
  const contentHash = hasher.digest("hex");

  // Build sources map (file path -> content + hash)
  const sources: Record<string, { contents: string; contentHash: string }> = {};
  for (const entry of bundle.entries) {
    sources[entry.relativePath] = {
      contents: entry.content,
      contentHash: entry.contentHash,
    };
  }

  // Build files array
  const files = bundle.entries.map((entry) => ({
    entry: entry.entry,
    out: entry.out,
    filePath: entry.relativePath,
  }));

  const buildManifest: BuildManifest = {
    target,
    packageVersion: sdkVersion ?? CORE_VERSION,
    cliPackageVersion: VERSION,
    contentHash,
    runtime: "python",
    environment,
    branch,
    config: configManifest,
    files,
    sources,
    outputPath: outputDir,
    // Python entry points - absolute paths to Python scripts in CLI package
    runWorkerEntryPoint: path.join(sourceDir, "entryPoints/python/managed-run-worker.py"),
    indexWorkerEntryPoint: path.join(sourceDir, "entryPoints/python/managed-index-worker.py"),
    configPath: config.configFile || "trigger.config.ts",
    build: {},
    deploy: {
      env: {},
    },
    customConditions: config.build?.conditions ?? [],
    otelImportHook: {
      include: config.instrumentedPackageNames ?? [],
    },
    requirementsContent: bundle.requirementsContent,
  };

  return buildManifest;
}
