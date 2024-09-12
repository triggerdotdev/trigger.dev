import { BuildTarget } from "@trigger.dev/core/v3";
import { join } from "node:path";
import { sourceDir } from "../sourceDir.js";

export const devRunWorker = join(sourceDir, "entryPoints", "dev-run-worker.js");
export const devIndexWorker = join(sourceDir, "entryPoints", "dev-index-worker.js");

export const deployRunController = join(sourceDir, "entryPoints", "deploy-run-controller.js");
export const deployRunWorker = join(sourceDir, "entryPoints", "deploy-run-worker.js");
export const deployIndexController = join(sourceDir, "entryPoints", "deploy-index-controller.js");
export const deployIndexWorker = join(sourceDir, "entryPoints", "deploy-index-worker.js");

export const telemetryEntryPoint = join(sourceDir, "entryPoints", "loader.js");

export const devEntryPoints = [devRunWorker, devIndexWorker];
export const deployEntryPoints = [
  deployRunController,
  deployRunWorker,
  deployIndexController,
  deployIndexWorker,
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
function isDeployIndexController(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/deploy-index-controller.js") ||
    entryPoint.includes("src/entryPoints/deploy-index-controller.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isDeployIndexWorker(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/deploy-index-worker.js") ||
    entryPoint.includes("src/entryPoints/deploy-index-worker.ts")
  );
}

function isDeployRunController(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/deploy-run-controller.js") ||
    entryPoint.includes("src/entryPoints/deploy-run-controller.ts")
  );
}

// IMPORTANT: this may look like it should not work on Windows, but it does (and changing to using path.join will break stuff)
function isDeployRunWorker(entryPoint: string) {
  return (
    entryPoint.includes("dist/esm/entryPoints/deploy-run-worker.js") ||
    entryPoint.includes("src/entryPoints/deploy-run-worker.ts")
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
  if (target === "dev") {
    return isDevRunWorker(entryPoint);
  } else {
    return isDeployRunWorker(entryPoint);
  }
}

export function isRunControllerForTarget(entryPoint: string, target: BuildTarget) {
  if (target === "deploy") {
    return isDeployRunController(entryPoint);
  }

  return false;
}

export function isIndexWorkerForTarget(entryPoint: string, target: BuildTarget) {
  if (target === "dev") {
    return isDevIndexWorker(entryPoint);
  } else {
    return isDeployIndexWorker(entryPoint);
  }
}

export function isIndexControllerForTarget(entryPoint: string, target: BuildTarget) {
  if (target === "deploy") {
    return isDeployIndexController(entryPoint);
  }

  return false;
}

export function isConfigEntryPoint(entryPoint: string) {
  return entryPoint.startsWith("trigger.config.ts");
}
