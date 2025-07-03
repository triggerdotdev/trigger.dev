import type { BuildExtension } from "@trigger.dev/core/v3/build";

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
  name: "lightpanda",
  onBuildComplete: async (context) => {
    if (context.target === "dev") {
      return;
    }

    const arch = context.targetPlatform === "linux/arm64" ? "aarch64" : "x86_64";

    context.logger.debug(`Adding lightpanda`, { arch, version, disableTelemetry });

    const instructions: string[] = [];

    // Install required packages
    instructions.push(
      `RUN apt-get update && apt-get install --no-install-recommends -y \
          curl \
          ca-certificates \
        && update-ca-certificates \
        && apt-get clean && rm -rf /var/lib/apt/lists/*`
    );

    // Install Lightpanda
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
          ...(disableTelemetry ? { LIGHTPANDA_DISABLE_TELEMETRY: "true" } : {}),
        },
        override: true,
      },
    });
  },
});
