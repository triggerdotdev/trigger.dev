import { join } from "node:path";
import { sourceDir } from "../sourceDir.js";
import { BuildTarget } from "@trigger.dev/core/v3";

export const devExecutorEntryPoint = join(sourceDir, "entryPoints", "dev-executor.js");
export const devIndexerEntryPoint = join(sourceDir, "entryPoints", "dev-indexer.js");

export const deployEntryPoint = join(sourceDir, "entryPoints", "deploy.js");
export const deployExecutorEntryPoint = join(sourceDir, "entryPoints", "deploy-executor.js");
export const deployIndexerEntryPoint = join(sourceDir, "entryPoints", "deploy-indexer.js");

export const telemetryEntryPoint = join(sourceDir, "entryPoints", "loader.js");

export const devEntryPoints = [devExecutorEntryPoint, devIndexerEntryPoint, telemetryEntryPoint];
export const deployEntryPoints = [
  deployIndexerEntryPoint,
  deployExecutorEntryPoint,
  deployEntryPoint,
  telemetryEntryPoint,
];

export const esmShimPath = join(sourceDir, "shims", "esm.js");

export const shims = [esmShimPath];

function isDevExecutorEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "dev-executor.js"));
}

function isDevIndexerEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "dev-indexer.js"));
}

function isDeployIndexerEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "deploy-indexer.js"));
}

function isDeployEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "deploy.js"));
}

function isDeployExecutorEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "deploy-executor.js"));
}

export function isLoaderEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "loader.js"));
}

export function isExecutorEntryPointForTarget(entryPoint: string, target: BuildTarget) {
  if (target === "dev") {
    return isDevExecutorEntryPoint(entryPoint);
  } else {
    return isDeployExecutorEntryPoint(entryPoint);
  }
}

export function isWorkerEntryPointForTarget(entryPoint: string, target: BuildTarget) {
  if (target === "deploy") {
    return isDeployEntryPoint(entryPoint);
  }

  return false;
}

export function isConfigEntryPoint(entryPoint: string) {
  return entryPoint.startsWith("trigger.config.ts");
}

export function isIndexerEntryPointForTarget(entryPoint: string, target: BuildTarget) {
  if (target === "dev") {
    return isDevIndexerEntryPoint(entryPoint);
  } else {
    return isDeployIndexerEntryPoint(entryPoint);
  }
}
