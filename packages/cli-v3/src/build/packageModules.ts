import { join } from "node:path";
import { sourceDir } from "../sourceDir.js";

export const devEntryPoint = join(sourceDir, "workers", "dev.js")
export const prodEntryPoint = join(sourceDir, "workers", "prod.js")
export const telemetryLoader = join(sourceDir, "telemetry", "loader.js")

export const packageModules = [
  devEntryPoint,
  prodEntryPoint,
  telemetryLoader,
]

export const esmShimPath = join(sourceDir, "shims", "esm.js")

export const shims = [
  esmShimPath
]