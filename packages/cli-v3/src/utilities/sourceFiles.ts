import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import type {
  BackgroundWorkerSourceFileMetadata,
  TaskFile,
  TaskManifest,
} from "@trigger.dev/core/v3/schemas";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import * as zlib from "node:zlib";
import { logger } from "./logger.js";

export type FileSource = { contents: string; contentHash: string };
export type FileSources = Record<string, FileSource>;

export async function resolveFileSources(
  files: TaskFile[],
  resolvedConfig: ResolvedConfig
): Promise<FileSources> {
  const sources: FileSources = {};

  for (const file of files) {
    const fullPath = join(resolvedConfig.workingDir, file.entry);
    const fileSource = await resolveFileSource(fullPath);

    if (!fileSource) {
      continue;
    }

    sources[file.entry] = fileSource;
  }

  await resolveConfigSource(sources, resolvedConfig.workingDir, resolvedConfig.configFile);
  await resolveConfigSource(sources, resolvedConfig.workingDir, resolvedConfig.tsconfigPath);
  await resolveConfigSource(sources, resolvedConfig.workingDir, resolvedConfig.packageJsonPath);

  return sources;
}

async function resolveConfigSource(sources: FileSources, workingDir: string, filePath?: string) {
  if (!filePath) {
    return;
  }

  const configSource = await resolveFileSource(filePath);

  if (configSource) {
    sources[relative(workingDir, filePath)] = configSource;
  }
}

async function resolveFileSource(filePath: string): Promise<FileSource | undefined> {
  try {
    const content = await readFile(filePath, "utf-8");
    const hasher = createHash("md5");
    hasher.update(content);

    return {
      contents: compressContent(content),
      contentHash: hasher.digest("hex"),
    };
  } catch (e) {
    logger.debug("Failed to read file", {
      filePath,
      error: e,
    });

    return;
  }
}

export function resolveSourceFiles(
  sources: Record<string, { contents: string; contentHash: string }>,
  tasks: TaskManifest[]
): Array<BackgroundWorkerSourceFileMetadata> {
  const tasksGroupedByFile: Record<string, TaskManifest[]> = {};

  for (const task of tasks) {
    if (!tasksGroupedByFile[task.filePath]) {
      tasksGroupedByFile[task.filePath] = [];
    }

    tasksGroupedByFile[task.filePath]!.push(task);
  }

  const taskFiles: Array<BackgroundWorkerSourceFileMetadata> = [];

  for (const [filePath, source] of Object.entries(sources)) {
    const tasks = tasksGroupedByFile[filePath] ?? [];

    const taskIds = tasks.map((task) => task.id);

    taskFiles.push({
      ...source,
      taskIds,
      filePath,
    });
  }

  return taskFiles;
}

function compressContent(data: string) {
  // Convert data to string if it's not already
  // Compress the data
  const compressedData = zlib.deflateSync(data);

  // Encode the compressed data to base64
  const base64Encoded = compressedData.toString("base64");

  return base64Encoded;
}
