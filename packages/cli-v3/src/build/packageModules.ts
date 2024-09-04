import { join } from "node:path";
import { sourceDir } from "../sourceDir.js";
import { BuildTarget } from "@trigger.dev/core/v3";
import { logger } from "../utilities/logger.js";

export const devRunWorker = join(sourceDir, "entryPoints", "dev-run-worker.js");
export const devIndexWorker = join(sourceDir, "entryPoints", "dev-index-worker.js");

export const deployRunController = join(sourceDir, "entryPoints", "deploy-run-controller.js");
export const deployRunWorker = join(sourceDir, "entryPoints", "deploy-run-worker.js");
export const deployIndexController = join(sourceDir, "entryPoints", "deploy-index-controller.js");
export const deployIndexWorker = join(sourceDir, "entryPoints", "deploy-index-worker.js");

export const telemetryEntryPoint = join(sourceDir, "entryPoints", "loader.js");

export const devEntryPoints = [devRunWorker, devIndexWorker, telemetryEntryPoint];
export const deployEntryPoints = [
  deployRunController,
  deployRunWorker,
  deployIndexController,
  deployIndexWorker,
  telemetryEntryPoint,
];

export const esmShimPath = join(sourceDir, "shims", "esm.js");

export const shims = [esmShimPath];

function isDevRunWorker(entryPoint: string) {
  return (
    entryPoint.includes(join("dist", "esm", "entryPoints", "dev-run-worker.js")) ||
    entryPoint.includes(join("src", "entryPoints", "dev-run-worker.ts"))
  );
}

function isDevIndexWorker(entryPoint: string) {
  return (
    entryPoint.includes(join("dist", "esm", "entryPoints", "dev-index-worker.js")) ||
    entryPoint.includes(join("src", "entryPoints", "dev-index-worker.ts"))
  );
}

function isDeployIndexController(entryPoint: string) {
  return (
    entryPoint.includes(join("dist", "esm", "entryPoints", "deploy-index-controller.js")) ||
    entryPoint.includes(join("src", "entryPoints", "deploy-index-controller.ts"))
  );
}

function isDeployIndexWorker(entryPoint: string) {
  return (
    entryPoint.includes(join("dist", "esm", "entryPoints", "deploy-index-worker.js")) ||
    entryPoint.includes(join("src", "entryPoints", "deploy-index-worker.ts"))
  );
}

function isDeployRunController(entryPoint: string) {
  return (
    entryPoint.includes(join("dist", "esm", "entryPoints", "deploy-run-controller.js")) ||
    entryPoint.includes(join("src", "entryPoints", "deploy-run-controller.ts"))
  );
}

function isDeployRunWorker(entryPoint: string) {
  return (
    entryPoint.includes(join("dist", "esm", "entryPoints", "deploy-run-worker.js")) ||
    entryPoint.includes(join("src", "entryPoints", "deploy-run-worker.ts"))
  );
}

export function isLoaderEntryPoint(entryPoint: string) {
  logger.debug("isLoaderEntryPoint", entryPoint, join("src", "entryPoints", "loader.ts"));

  return (
    entryPoint.includes(join("dist", "esm", "entryPoints", "loader.js")) ||
    entryPoint.includes(join("src", "entryPoints", "loader.ts"))
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
