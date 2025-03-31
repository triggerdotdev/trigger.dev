import type { BuildContext, BuildExtension } from "@trigger.dev/build";

// This is a custom build extension to install Playwright and Chromium
export function installPlaywrightChromium(): BuildExtension {
  return {
    name: "InstallPlaywrightChromium",
    onBuildComplete(context: BuildContext) {
      const instructions = [
        // Base and Chromium dependencies
        `RUN apt-get update && apt-get install -y --no-install-recommends \
          curl unzip npm libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
          libasound2 libnss3 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
          libgbm1 libxkbcommon0 \
          && apt-get clean && rm -rf /var/lib/apt/lists/*`,

        // Install Playwright and Chromium
        `RUN npm install -g playwright`,
        `RUN mkdir -p /ms-playwright`,
        `RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright python -m playwright install --with-deps chromium`,
      ];

      context.addLayer({
        id: "playwright",
        image: { instructions },
        deploy: {
          env: {
            PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
            PLAYWRIGHT_SKIP_BROWSER_VALIDATION: "1",
          },
          override: true,
        },
      });
    },
  };
}
