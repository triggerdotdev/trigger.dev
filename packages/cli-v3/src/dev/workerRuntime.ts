import type { BuildManifest } from "@trigger.dev/core/v3";
import type {} from "../apiClient.js";
import type { Metafile } from "esbuild";

export interface WorkerRuntime {
  shutdown(): Promise<void>;
  initializeWorker(manifest: BuildManifest, metafile: Metafile, stop: () => void): Promise<void>;
}
