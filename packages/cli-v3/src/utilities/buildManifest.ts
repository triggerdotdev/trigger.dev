import { BuildManifest } from "@trigger.dev/core/v3/schemas";

export function buildManifestToJSON(manifest: BuildManifest): BuildManifest {
  const { deploy, build, ...rest } = manifest;

  return {
    ...rest,
    deploy: {},
    build: {},
  };
}
