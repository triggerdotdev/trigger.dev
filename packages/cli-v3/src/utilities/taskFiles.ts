import { ResolvedConfig } from "@trigger.dev/core/v3";
import fs from "node:fs";
import { join, relative, resolve } from "node:path";
import { TaskFile } from "../types";

export function createTaskFileImports(taskFiles: TaskFile[]) {
  return taskFiles
    .map(
      (taskFile) =>
        `import * as ${taskFile.importName} from "./${taskFile.importPath}"; TaskFileImports["${
          taskFile.importName
        }"] = ${taskFile.importName}; TaskFiles["${taskFile.importName}"] = ${JSON.stringify(
          taskFile
        )};`
    )
    .join("\n");
}

// Find all the top-level .js or .ts files in the trigger directories
export async function gatherTaskFiles(config: ResolvedConfig): Promise<Array<TaskFile>> {
  const taskFiles: Array<TaskFile> = [];

  for (const triggerDir of config.triggerDirectories) {
    const files = await fs.promises.readdir(triggerDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      if (
        !file.name.endsWith(".js") &&
        !file.name.endsWith(".ts") &&
        !file.name.endsWith(".jsx") &&
        !file.name.endsWith(".tsx")
      ) {
        continue;
      }

      const fullPath = join(triggerDir, file.name);
      const filePath = relative(config.projectDir, fullPath);

      //remove the file extension and replace any invalid characters with underscores
      const importName = filePath.replace(/\..+$/, "").replace(/[^a-zA-Z0-9_$]/g, "_");

      //change backslashes to forward slashes
      const importPath = filePath.replace(/\\/g, "/");

      taskFiles.push({ triggerDir, importPath, importName, filePath });
    }
  }

  return taskFiles;
}

export function resolveTriggerDirectories(dirs: string[]): string[] {
  return dirs.map((dir) => resolve(dir));
}

const IGNORED_DIRS = ["node_modules", ".git", "dist", "build"];

export async function findTriggerDirectories(dirPath: string): Promise<string[]> {
  return getTriggerDirectories(dirPath);
}

async function getTriggerDirectories(dirPath: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const triggerDirectories: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.includes(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);

    if (entry.name === "trigger") {
      triggerDirectories.push(fullPath);
    }

    triggerDirectories.push(...(await getTriggerDirectories(fullPath)));
  }

  return triggerDirectories;
}
