import { BuildManifest, ImportTaskFileErrors, resourceCatalog } from "@trigger.dev/core/v3";
import { normalizeImportPath } from "../utilities/normalizeImportPath.js";

export async function registerResources(
  buildManifest: BuildManifest
): Promise<{ importErrors: ImportTaskFileErrors; timings: Record<string, number> }> {
  const importErrors: ImportTaskFileErrors = [];
  const timings: Record<string, number> = {};

  for (const file of buildManifest.files) {
    // Set the context before importing
    resourceCatalog.setCurrentFileContext(file.entry, file.out);

    const start = performance.now();
    const [error, _] = await tryImport(file.out);
    const end = performance.now();
    timings[file.entry] = end - start;

    // Clear the context after import, regardless of success/failure
    resourceCatalog.clearCurrentFileContext();

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
  }

  return { importErrors, timings };
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
