import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "tinyglobby";
import * as tar from "tar";
import ignore from "ignore";
import { tryCatch } from "@trigger.dev/core/v3";
import { logger } from "../utilities/logger.js";

const DEFAULT_IGNORES = [
  ".git/**",
  "node_modules/**",
  "**/.DS_Store",
  "**/.git",
  "**/node_modules",
  "**/*.log",
  "**/npm-debug.log*",
  "**/yarn-debug.log*",
  "**/yarn-error.log*",
  "**/.npm",
  "**/.eslintcache",
  "**/.node_repl_history",
  "**/.yarn-integrity",
  "**/coverage",
  "**/.nyc_output",
  "**/.cache",
  "**/.parcel-cache",
  "**/.next",
  "**/.nuxt",
  "**/dist",
  "**/.turbo",
  "**/.vercel",
  "**/out",
  "**/.temp",
  "**/.tmp",
  "**/.trigger",
  "**/.env",
  "**/.env.local",
  "**/Thumbs.db",
  "**/.idea",
  "**/.vscode",
  "**/.output",
  "**/.yarn",
  "**/build",
  "**/__pycache__",
  "**/*.pyc",
  "**/.venv",
  "**/venv",
];

async function getGitignoreContent(gitignorePath: string): Promise<string> {
  if (!existsSync(gitignorePath)) {
    return "";
  }

  const [error, content] = await tryCatch(readFile(gitignorePath, "utf-8"));

  if (error) {
    throw new Error(`Failed to read .gitignore at ${gitignorePath}: ${error.message}`);
  }

  return content;
}

function gitignoreToGlobs(content: string): string[] {
  if (content.includes("!")) {
    return [];
  }

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((pattern) => {
      if (pattern.endsWith("/")) {
        const isAnchored = pattern.startsWith("/");
        const cleanPattern = pattern.replace(/^\//, "");

        if (isAnchored) {
          return `${cleanPattern}**`;
        }
        return `**/${cleanPattern}**`;
      }

      // For files, we only pass exact root matches or simple patterns to help with root clutter
      // complex wildcards are hard to map perfectly to fast-glob ignores without risk
      return pattern;
    });
}

export async function createContextArchive(workspaceDir: string, outputPath: string) {
  logger.debug("Creating context archive", { workspaceDir, outputPath });

  // read .gitignore if it exists
  const gitignorePath = join(workspaceDir, ".gitignore");
  const gitignoreContent = await getGitignoreContent(gitignorePath);

  const ig = ignore();
  ig.add(DEFAULT_IGNORES);
  if (gitignoreContent) {
    ig.add(gitignoreContent);
  }

  // performance optimization
  const gitignoreGlobs = gitignoreToGlobs(gitignoreContent);
  const globIgnorePatterns = [...DEFAULT_IGNORES, ...gitignoreGlobs];

  logger.debug("Ignore patterns for glob", { count: globIgnorePatterns.length });

  // find all files to include in the archive
  const startTime = Date.now();
  const allFiles = await glob(["**/*"], {
    cwd: workspaceDir,
    ignore: globIgnorePatterns,
    dot: true,
    absolute: false,
    onlyFiles: true,
    followSymbolicLinks: false, // don't follow symlinks to avoid infinite loops or outside access
  });

  // filter using ignore package for correctness
  const files = allFiles.filter((file) => !ig.ignores(file));

  const scanDuration = Date.now() - startTime;

  logger.debug("Files to archive", {
    count: files.length,
    scanDurationMs: scanDuration,
    ignoredCount: allFiles.length - files.length,
  });

  if (files.length === 0) {
    throw new Error("No files found to archive. Check your .gitignore settings.");
  }

  await tar.create(
    {
      gzip: true,
      file: outputPath,
      cwd: workspaceDir,
      portable: true,
      preservePaths: false,
      mtime: new Date(0),
    },
    files
  );

  logger.debug("Archive created", { outputPath, fileCount: files.length });
}

export async function getArchiveSize(archivePath: string): Promise<number> {
  const { statSync } = await import("node:fs");
  return statSync(archivePath).size;
}
