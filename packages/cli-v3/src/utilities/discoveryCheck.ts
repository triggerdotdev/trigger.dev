import { glob, isDynamicPattern } from "tinyglobby";
import { tryCatch } from "@trigger.dev/core/utils";
import { expandTilde, pathExists, readFile } from "./fileSystem.js";
import { logger } from "./logger.js";
import path from "node:path";

export type DiscoverySpec = {
  filePatterns: string[];
  contentPattern?: string;
  matchBehavior: "show-if-found" | "show-if-not-found";
};

const REGEX_METACHARACTERS = /[\\^$.|?*+(){}[\]]/;

/**
 * Evaluates a discovery spec against the local filesystem.
 * Returns `true` if the notification should be shown, `false` otherwise.
 * Fails closed: any error returns `false` (suppress notification).
 */
export async function evaluateDiscovery(
  spec: DiscoverySpec,
  projectRoot: string
): Promise<boolean> {
  const [error, result] = await tryCatch(doEvaluate(spec, projectRoot));

  if (error) {
    logger.debug("Discovery check failed, suppressing notification", { error });
    return false;
  }

  return result;
}

async function doEvaluate(spec: DiscoverySpec, projectRoot: string): Promise<boolean> {
  logger.debug("Discovery: starting evaluation", {
    filePatterns: spec.filePatterns,
    contentPattern: spec.contentPattern,
    matchBehavior: spec.matchBehavior,
    projectRoot,
  });

  const matchedFiles = await resolveFilePatterns(spec.filePatterns, projectRoot);
  const hasFileMatch = matchedFiles.length > 0;

  if (!hasFileMatch) {
    const result = spec.matchBehavior === "show-if-not-found";
    logger.debug("Discovery: no files matched any pattern", { result });
    return result;
  }

  // Files matched — if no content pattern, decide based on file match alone
  if (!spec.contentPattern) {
    const result = spec.matchBehavior === "show-if-found";
    logger.debug("Discovery: files matched, no content pattern to check", {
      matchedFiles,
      result,
    });
    return result;
  }

  // Check content in matched files
  const hasContentMatch = await checkContentPattern(matchedFiles, spec.contentPattern);

  const result =
    spec.matchBehavior === "show-if-found" ? hasContentMatch : !hasContentMatch;

  logger.debug("Discovery: evaluation complete", {
    matchedFiles,
    contentPattern: spec.contentPattern,
    hasContentMatch,
    result,
  });

  return result;
}

async function resolveFilePatterns(
  patterns: string[],
  projectRoot: string
): Promise<string[]> {
  const matched: string[] = [];

  for (const pattern of patterns) {
    const isHomeDirPattern = pattern.startsWith("~/");
    const resolvedPattern = isHomeDirPattern ? expandTilde(pattern) : pattern;
    const cwd = isHomeDirPattern ? "/" : projectRoot;
    const isGlob = isDynamicPattern(resolvedPattern);

    logger.debug("Discovery: resolving pattern", {
      pattern,
      resolvedPattern,
      cwd,
      isGlob,
      isHomeDirPattern,
    });

    if (isGlob) {
      const files = await glob({
        patterns: [resolvedPattern],
        cwd,
        absolute: true,
        dot: true,
      });
      if (files.length > 0) {
        logger.debug("Discovery: glob matched files", { pattern, files });
      }
      matched.push(...files);
    } else {
      const absolutePath = isHomeDirPattern
        ? resolvedPattern
        : path.resolve(projectRoot, resolvedPattern);
      const exists = await pathExists(absolutePath);
      logger.debug("Discovery: literal path check", { pattern, absolutePath, exists });
      if (exists) {
        matched.push(absolutePath);
      }
    }
  }

  return matched;
}

async function checkContentPattern(
  files: string[],
  contentPattern: string
): Promise<boolean> {
  const useFastPath = !REGEX_METACHARACTERS.test(contentPattern);

  logger.debug("Discovery: checking content pattern", {
    contentPattern,
    useFastPath,
    fileCount: files.length,
  });

  for (const filePath of files) {
    const [error, content] = await tryCatch(readFile(filePath));

    if (error) {
      logger.debug("Discovery: failed to read file, skipping", { filePath, error });
      continue;
    }

    const matches = useFastPath
      ? content.includes(contentPattern)
      : new RegExp(contentPattern).test(content);

    logger.debug("Discovery: content check result", { filePath, matches });

    if (matches) {
      return true;
    }
  }

  return false;
}
