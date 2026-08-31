import { BuildExtension } from "@trigger.dev/core/v3/build";
import { addAdditionalFilesToBuild } from "../../internal/additionalFiles.js";

export type AdditionalFilesOptions = {
  files: string[];
};

export function additionalFiles(options: AdditionalFilesOptions): BuildExtension {
  return {
    name: "additionalFiles",
    async onBuildComplete(context, manifest) {
      await addAdditionalFilesToBuild("additionalFiles", options, context, manifest);
    },
  };
}
