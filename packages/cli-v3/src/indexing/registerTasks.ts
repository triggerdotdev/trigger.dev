import { BuildManifest, ImportTaskFileErrors, taskCatalog } from "@trigger.dev/core/v3";
import { normalizeImportPath } from "../utilities/normalizeImportPath.js";

export async function registerTasks(buildManifest: BuildManifest): Promise<ImportTaskFileErrors> {
  const importErrors: ImportTaskFileErrors = [];

  for (const file of buildManifest.files) {
    const [error, module] = await tryImport(file.out);

    if (error) {
      if (typeof error === "string") {
        importErrors.push({
          file: file.entry,
          message: error,
        });
      } else {
        importErrors.push({
          file: file.entry,
          message: error.message,
          stack: error.stack,
          name: error.name,
        });
      }

      continue;
    }

    for (const exportName of getExportNames(module)) {
      const task = module[exportName] ?? module.default?.[exportName];

      if (!task) {
        continue;
      }

      if (task[Symbol.for("trigger.dev/task")]) {
        if (taskCatalog.taskExists(task.id)) {
          taskCatalog.registerTaskFileMetadata(task.id, {
            exportName,
            filePath: file.entry,
            entryPoint: file.out,
          });
        }
      }
    }
  }

  return importErrors;
}

type Result<T> = [Error | null, T | null];

async function tryImport(path: string): Promise<Result<any>> {
  try {
    const module = await import(normalizeImportPath(path));

    return [null, module];
  } catch (error) {
    return [error as Error, null];
  }
}

function getExportNames(module: any) {
  const exports: string[] = [];

  const exportKeys = Object.keys(module);

  if (exportKeys.length === 0) {
    return exports;
  }

  if (exportKeys.length === 1 && exportKeys[0] === "default") {
    return Object.keys(module.default);
  }

  return exportKeys;
}
