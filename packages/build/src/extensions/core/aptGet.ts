import { BuildExtension } from "@trigger.dev/core/v3/build";

export type AptGetOptions = {
  packages: string[];
};

export function aptGet(options: AptGetOptions): BuildExtension {
  return {
    name: "aptGet",
    onBuildComplete(context) {
      if (context.target === "dev") {
        return;
      }

      context.logger.debug("Adding apt-get layer", {
        pkgs: options.packages,
      });

      context.addLayer({
        id: "apt-get",
        image: {
          pkgs: options.packages,
        },
      });
    },
  };
}
