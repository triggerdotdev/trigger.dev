import { join } from "node:path";
import { sourceDir } from "../sourceDir.js";

export const devEntryPoint = join(sourceDir, "entryPoints", "dev.js");
export const deployEntryPoint = join(sourceDir, "entryPoints", "deploy.js");
export const telemetryEntryPoint = join(sourceDir, "entryPoints", "loader.js");
export const indexerEntryPoint = join(sourceDir, "entryPoints", "indexer.js");
export const deployIndexerEntryPoint = join(sourceDir, "entryPoints", "deploy-indexer.js");

export const devEntryPoints = [devEntryPoint, indexerEntryPoint, telemetryEntryPoint];
export const deployEntryPoints = [deployIndexerEntryPoint, deployEntryPoint, telemetryEntryPoint];

export const esmShimPath = join(sourceDir, "shims", "esm.js");

export const shims = [esmShimPath];

export function isDevEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "dev.js"));
}

export function isIndexerEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "indexer.js"));
}

export function isDeployIndexerEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "deploy-indexer.js"));
}

export function isDeployEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "deploy.js"));
}

export function isLoaderEntryPoint(entryPoint: string) {
  return entryPoint.includes(join("dist", "esm", "entryPoints", "loader.js"));
}
