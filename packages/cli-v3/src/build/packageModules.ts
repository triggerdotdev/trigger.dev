import { BuildTarget } from "@trigger.dev/core/v3";
import { join } from "node:path";
import { sourceDir } from "../sourceDir.js";
import { assertExhaustive } from "../utilities/assertExhaustive.js";

export const devRunWorker = join(sourceDir, "entryPoints", "dev-run-worker.js");
export const devIndexWorker = join(sourceDir, "entryPoints", "dev-index-worker.js");

export const managedRunController = join(sourceDir, "entryPoints", "managed-run-controller.js");
export const managedRunWorker = join(sourceDir, "entryPoints", "managed-run-worker.js");
export const managedIndexController = join(sourceDir, "entryPoints", "managed-index-controller.js");
export const managedIndexWorker = join(sourceDir, "entryPoints", "managed-index-worker.js");

export const unmanagedRunController = join(sourceDir, "entryPoints", "unmanaged-run-controller.js");
export const unmanagedRunWorker = join(sourceDir, "entryPoints", "unmanaged-run-worker.js");
export const unmanagedIndexController = join(
  sourceDir,
  "entryPoints",
  "unmanaged-index-controller.js"
);
export const unmanagedIndexWorker = join(sourceDir, "entryPoints", "unmanaged-index-worker.js");

export const telemetryEntryPoint = join(sourceDir, "entryPoints", "loader.js");

export const devEntryPoints = [devRunWorker, devIndexWorker];
export const managedEntryPoints = [
  managedRunController,
  managedRunWorker,
  managedIndexController,
  managedIndexWorker,
];
export const unmanagedEntryPoints = [
  unmanagedRunController,
  unmanagedRunWorker,
  unmanagedIndexController,
  unmanagedIndexWorker,
];

export const esmShimPath = join(sourceDir, "shims", "esm.js");

export const shims = [esmShimPath];

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isDevRunWorker(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/dev-run-worker.js") ||
    entryPoint.includes("src/entryPoints/dev-run-worker.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isDevIndexWorker(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/dev-index-worker.js") ||
    entryPoint.includes("src/entryPoints/dev-index-worker.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isManagedRunController(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/managed-run-controller.js") ||
    entryPoint.includes("src/entryPoints/managed-run-controller.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isManagedRunWorker(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/managed-run-worker.js") ||
    entryPoint.includes("src/entryPoints/managed-run-worker.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isManagedIndexController(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/managed-index-controller.js") ||
    entryPoint.includes("src/entryPoints/managed-index-controller.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isManagedIndexWorker(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/managed-index-worker.js") ||
    entryPoint.includes("src/entryPoints/managed-index-worker.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isUnmanagedRunController(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/unmanaged-run-controller.js") ||
    entryPoint.includes("src/entryPoints/unmanaged-run-controller.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isUnmanagedRunWorker(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/unmanaged-run-worker.js") ||
    entryPoint.includes("src/entryPoints/unmanaged-run-worker.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isUnmanagedIndexController(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/unmanaged-index-controller.js") ||
    entryPoint.includes("src/entryPoints/unmanaged-index-controller.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isUnmanagedIndexWorker(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/unmanaged-index-worker.js") ||
    entryPoint.includes("src/entryPoints/unmanaged-index-worker.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
export function isLoaderEntryPoint(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/loader.js") ||
    entryPoint.includes("src/entryPoints/loader.ts")
  );
}

export function isRunWorkerForTarget(entryPoint: string, target: BuildTarget) {
  switch (target) {
    case "dev":
      return isDevRunWorker(entryPoint);
    case "deploy":
      return isManagedRunWorker(entryPoint);
    case "unmanaged":
      return isUnmanagedRunWorker(entryPoint);
    default:
      assertExhaustive(target);
  }
}

export function getRunWorkerForTarget(target: BuildTarget) {
  switch (target) {
    case "dev":
      return devRunWorker;
    case "deploy":
      return managedRunWorker;
    case "unmanaged":
      return unmanagedRunWorker;
    default:
      assertExhaustive(target);
  }
}

export function isRunControllerForTarget(entryPoint: string, target: BuildTarget) {
  switch (target) {
    case "dev":
      return false;
    case "deploy":
      return isManagedRunController(entryPoint);
    case "unmanaged":
      return isUnmanagedRunController(entryPoint);
    default:
      assertExhaustive(target);
  }
}

export function getRunControllerForTarget(target: BuildTarget) {
  switch (target) {
    case "dev":
      return undefined;
    case "deploy":
      return managedRunController;
    case "unmanaged":
      return unmanagedRunController;
    default:
      assertExhaustive(target);
  }
}

export function isIndexWorkerForTarget(entryPoint: string, target: BuildTarget) {
  switch (target) {
    case "dev":
      return isDevIndexWorker(entryPoint);
    case "deploy":
      return isManagedIndexWorker(entryPoint);
    case "unmanaged":
      return isUnmanagedIndexWorker(entryPoint);
    default:
      assertExhaustive(target);
  }
}

export function getIndexWorkerForTarget(target: BuildTarget) {
  switch (target) {
    case "dev":
      return devIndexWorker;
    case "deploy":
      return managedIndexWorker;
    case "unmanaged":
      return unmanagedIndexWorker;
    default:
      assertExhaustive(target);
  }
}

export function isIndexControllerForTarget(entryPoint: string, target: BuildTarget) {
  switch (target) {
    case "dev":
      return false;
    case "deploy":
      return isManagedIndexController(entryPoint);
    case "unmanaged":
      return isUnmanagedIndexController(entryPoint);
    default:
      assertExhaustive(target);
  }
}

export function getIndexControllerForTarget(target: BuildTarget) {
  switch (target) {
    case "dev":
      return undefined;
    case "deploy":
      return managedIndexController;
    case "unmanaged":
      return unmanagedIndexController;
    default:
      assertExhaustive(target);
  }
}

export function isConfigEntryPoint(entryPoint: string) {
  return entryPoint.startsWith("trigger.config.ts");
}
