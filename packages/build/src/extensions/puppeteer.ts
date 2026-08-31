import { BuildManifest } from "@trigger.dev/core/v3";
import { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";

export function puppeteer() {
  return new PuppeteerExtension();
}

class PuppeteerExtension implements BuildExtension {
  public readonly name = "PuppeteerExtension";

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") {
      return;
    }

    context.logger.debug(`Adding ${this.name} to the build`);

    const instructions = [
      `RUN apt-get update && apt-get install curl gnupg -y \
  && curl --location --silent https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install google-chrome-stable -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*`,
    ];

    context.addLayer({
      id: "puppeteer",
      image: {
        instructions,
      },
      deploy: {
        env: {
          PUPPETEER_EXECUTABLE_PATH: "/usr/bin/google-chrome-stable",
        },
        override: true,
      },
    });
  }
}
