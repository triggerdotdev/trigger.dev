import type { BuildExtension } from "@trigger.dev/core/v3/build";

type LightpandaOpts = {
  version?: "nightly" | "latest";
  disableTelemetry?: boolean;
};

export const lightpanda = ({
  version = "latest",
  disableTelemetry = false,
}: LightpandaOpts = {}): BuildExtension => ({
  name: "lightpanda",
  onBuildComplete: async (context) => {
    if (context.target === "dev") {
      return;
    }

    context.logger.debug(`Adding lightpanda`, { version, disableTelemetry });

    const instructions = [
      `COPY --from=lightpanda/browser:${version} /usr/bin/lightpanda /usr/local/bin/lightpanda`,
      `RUN /usr/local/bin/lightpanda version || (echo "lightpanda binary is not functional" && exit 1)`,
    ] satisfies string[];

    context.addLayer({
      id: "lightpanda",
      image: {
        instructions,
      },
      deploy: {
        env: {
          ...(disableTelemetry ? { LIGHTPANDA_DISABLE_TELEMETRY: "true" } : {}),
        },
        override: true,
      },
    });
  },
});
