import { createRequire } from "node:module";
import { join } from "node:path";

export type TypeScriptCompiler = typeof import("typescript");

const compilerPackages = ["typescript", "@typescript/typescript6"] as const;

function hasTranspileModule(value: unknown): value is TypeScriptCompiler {
  return (
    typeof value === "object" &&
    value !== null &&
    "transpileModule" in value &&
    typeof value.transpileModule === "function"
  );
}

function isUnavailablePackage(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED")
  );
}

export function loadTypescript(
  projectDir: string,
  packageNames: readonly string[] = compilerPackages
): TypeScriptCompiler {
  const requireFromProject = createRequire(join(projectDir, "package.json"));
  const loadErrors: Error[] = [];

  for (const packageName of packageNames) {
    let resolvedPackage: string;

    try {
      resolvedPackage = requireFromProject.resolve(packageName);
    } catch (error) {
      if (isUnavailablePackage(error)) {
        continue;
      }

      throw error;
    }

    let compiler: unknown;

    try {
      compiler = requireFromProject(resolvedPackage);
    } catch (error) {
      loadErrors.push(
        new Error(`Failed to load "${packageName}" from ${projectDir}.`, { cause: error })
      );
      continue;
    }

    if (hasTranspileModule(compiler)) {
      return compiler;
    }
  }

  if (loadErrors.length === 1) {
    throw loadErrors[0];
  }

  if (loadErrors.length > 1) {
    throw new AggregateError(
      loadErrors,
      `Failed to load a compatible TypeScript compiler from ${projectDir}.`
    );
  }

  throw new Error(
    [
      "The emitDecoratorMetadata() build extension requires the TypeScript JavaScript compiler API,",
      "which TypeScript 7 does not expose.",
      "",
      "Install the TypeScript 6 compatibility package alongside TypeScript 7:",
      "",
      "  npm install --save-dev @typescript/typescript6",
      "",
      "Restart the Trigger.dev dev server after installing the package.",
      "See https://trigger.dev/docs/config/extensions/emitDecoratorMetadata#using-with-typescript-7",
    ].join("\n")
  );
}
