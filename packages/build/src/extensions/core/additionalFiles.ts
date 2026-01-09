import { BuildExtension } from "@trigger.dev/core/v3/build";
import { addAdditionalFilesToBuild } from "../../internal/additionalFiles.js";

export type AdditionalFilesOptions = {
  files: string[];
  /**
   * Optional destination directory for the matched files.
   *
   * When specified, files will be placed under this directory while preserving
   * their structure relative to the glob pattern's base directory.
   *
   * This is useful when including files from parent directories (using `..` in the glob pattern),
   * as the default behavior strips `..` segments which can result in unexpected destination paths.
   *
   * @example
   * // In a monorepo with structure: apps/trigger, apps/shared
   * // From apps/trigger/trigger.config.ts:
   * additionalFiles({
   *   files: ["../shared/**"],
   *   destination: "apps/shared"
   * })
   * // Files from ../shared/utils.ts will be copied to apps/shared/utils.ts
   */
  destination?: string;
};

export function additionalFiles(options: AdditionalFilesOptions): BuildExtension {
  return {
    name: "additionalFiles",
    async onBuildComplete(context, manifest) {
      await addAdditionalFilesToBuild("additionalFiles", options, context, manifest);
    },
  };
}
