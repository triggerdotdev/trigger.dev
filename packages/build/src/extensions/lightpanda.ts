import type { BuildExtension } from "@trigger.dev/core/v3/build";

type LightpandaOpts = {
  arch?: 'aarch64' | 'x86_64'
  version?: 'nightly'
}

export const lightpanda = ({ arch = 'x86_64', version = 'nightly' }: LightpandaOpts = {}): BuildExtension => ({
  name: "LightpandaExtension",
  onBuildComplete: async (context) => {
    if (context.target === "dev") {
      return
    }

    context.logger.debug(lightpanda.name);
    context.addLayer({
      id: "lightpanda",
      image: {
        instructions: [
          `RUN apt-get update && apt-get install curl -y \ &&
            curl -L -o lightpanda https://github.com/lightpanda-io/browser/releases/download/${version}/lightpanda-${arch}-linux \ &&
            chmod a+x ./lightpanda`,
        ],
      },
    })
  },
})
