import type { BuildExtension } from "@trigger.dev/core/v3/build";

const NAME = "LightpandaExtension";

type LightpandaOpts = {
  arch?: "aarch64" | "x86_64";
  version?: "nightly";
  disableTelemetry?: boolean;
};

export const lightpanda = ({
  arch = "x86_64",
  version = "nightly",
  disableTelemetry = false,
}: LightpandaOpts = {}): BuildExtension => ({
  name: NAME,
  onBuildComplete: async (context) => {
    context.logger.progress(`Running ${NAME} on ${context.target} env for arch ${arch}`);
    context.logger.progress(`version: ${version}`);

    if (context.target === "dev") {
      return;
    }

    const instructions: string[] = [];

    if (disableTelemetry) {
      instructions.push("RUN export LIGHTPANDA_DISABLE_TELEMETRY=true");
    }

    /* Update / install required packages */
    instructions.push(
      `RUN apt-get update && apt-get install --no-install-recommends -y \
        curl \
        ca-certificates \
        && update-ca-certificates \
        && apt-get clean && rm -rf /var/lib/apt/lists/*`
    );

    /* Install Lightpanda */
    instructions.push(
      `RUN curl -L -f --retry 3 -o lightpanda https://github.com/lightpanda-io/browser/releases/download/${version}/lightpanda-${arch}-linux || (echo "Failed to download Lightpanda binary" && exit 1) \
        && chmod a+x ./lightpanda \
        && mv ./lightpanda /usr/bin/lightpanda \
        && /usr/bin/lightpanda version || (echo "Downloaded binary is not functional" && exit 1)`
    );

    context.addLayer({
      id: "lightpanda",
      image: {
        instructions,
      },
      deploy: {
        env: {
          LIGHTPANDA_BROWSER_PATH: "/usr/bin/lightpanda",
        },
        override: true,
      },
    });
  },
});
