import type { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";

type PlaywrightBrowser = "chromium" | "firefox" | "webkit";

interface PlaywrightExtensionOptions {
  /**
   * Browsers to install. Select only needed browsers to optimize build time and size.
   * @default ["chromium"]
   */
  browsers?: PlaywrightBrowser[];

  /**
   * Whether to support non-headless mode.
   * @default true
   */
  headless?: boolean;
}

/**
 * Creates a Playwright extension for trigger.dev
 * @param options Configuration options
 */
export function playwright(options: PlaywrightExtensionOptions = {}) {
  return new PlaywrightExtension(options);
}

class PlaywrightExtension implements BuildExtension {
  public readonly name = "PlaywrightExtension";
  private readonly options: Required<PlaywrightExtensionOptions>;

  constructor({ browsers = ["chromium"], headless = true }: PlaywrightExtensionOptions = {}) {
    if (browsers && browsers.length === 0) {
      throw new Error("At least one browser must be specified");
    }
    this.options = { browsers, headless };
  }

  onBuildComplete(context: BuildContext) {
    if (context.target === "dev") return;

    context.logger.debug(
      `Adding ${this.name} to the build with browsers: ${this.options.browsers.join(", ")}`
    );

    const instructions: string[] = [
      // Base dependencies
      `RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        unzip \
        jq \
        grep \
        sed \
        npm \
        && apt-get clean && rm -rf /var/lib/apt/lists/*`,

      // Install Playwright globally
      `RUN npm install -g playwright`,
    ];

    // Browser-specific dependencies
    const chromiumDeps = [
      "libnspr4",
      "libatk1.0-0",
      "libatk-bridge2.0-0",
      "libatspi2.0-0",
      "libasound2",
      "libnss3",
      "libxcomposite1",
      "libxdamage1",
      "libxfixes3",
      "libxrandr2",
      "libgbm1",
      "libxkbcommon0",
    ];

    const firefoxDeps = [
      "libgtk-3.0",
      "libgtk-4-1",
      "libgtk-4-common",
      "libgtk-4-dev",
      "libgtk-4-doc",
      "libasound2",
    ];

    const webkitDeps = [
      "libenchant-2-2",
      "libgl1",
      "libgles2",
      "libgstreamer-gl1.0-0",
      "libgstreamer-plugins-base1.0-0",
      "libgstreamer-plugins-bad1.0-0",
      "libharfbuzz-icu0",
      "libhyphen0",
      "libicu72",
      "libjpeg-dev",
      "libopenjp2-7",
      "libopus0",
      "libpng-dev",
      "libsecret-1-0",
      "libvpx7",
      "libwebp7",
      "libwoff1",
      "libx11-6",
      "libxcomposite1",
      "libxdamage1",
      "libxrender1",
      "libxt6",
      "libgtk-4-1",
      "libgraphene-1.0-0",
      "libxslt1.1",
      "libevent-2.1-7",
      "libmanette-0.2-0",
      "libwebpdemux2",
      "libwebpmux3",
      "libatomic1",
      "libavif15",
      "libx264-dev",
      "flite",
      "libatk1.0-0",
      "libatk-bridge2.0-0",
    ];

    const deps = [];
    if (this.options.browsers.includes("chromium")) deps.push(...chromiumDeps);
    if (this.options.browsers.includes("firefox")) deps.push(...firefoxDeps);
    if (this.options.browsers.includes("webkit")) deps.push(...webkitDeps);

    const uniqueDeps = [...new Set(deps)];

    if (uniqueDeps.length > 0) {
      instructions.push(
        `RUN apt-get update && apt-get install -y --no-install-recommends ${uniqueDeps.join(" ")} \
        && apt-get clean && rm -rf /var/lib/apt/lists/*`
      );
    }

    // Setup Playwright browsers
    instructions.push(`RUN mkdir -p /ms-playwright`);
    instructions.push(`RUN npx playwright install --dry-run > /tmp/browser-info.txt`);

    this.options.browsers.forEach((browser) => {
      const browserType = browser === "chromium" ? "chromium-headless-shell" : browser;

      instructions.push(
        `RUN grep -A5 "browser: ${browserType}" /tmp/browser-info.txt > /tmp/${browser}-info.txt`,

        `RUN INSTALL_DIR=$(grep "Install location:" /tmp/${browser}-info.txt | cut -d':' -f2- | xargs) && \
          DIR_NAME=$(basename "$INSTALL_DIR") && \
          MS_DIR="/ms-playwright/$DIR_NAME" && \
          mkdir -p "$MS_DIR"`,

        `RUN DOWNLOAD_URL=$(grep "Download url:" /tmp/${browser}-info.txt | cut -d':' -f2- | xargs | sed "s/mac-arm64/linux/g" | sed "s/mac-15-arm64/ubuntu-20.04/g") && \
          echo "Downloading ${browser} from $DOWNLOAD_URL" && \
          curl -L -o /tmp/${browser}.zip "$DOWNLOAD_URL" && \
          unzip -q /tmp/${browser}.zip -d "/ms-playwright/$(basename $(grep "Install location:" /tmp/${browser}-info.txt | cut -d':' -f2- | xargs))" && \
          chmod -R +x "/ms-playwright/$(basename $(grep "Install location:" /tmp/${browser}-info.txt | cut -d':' -f2- | xargs))" && \
          rm /tmp/${browser}.zip`
      );
    });

    // Environment variables
    const envVars: Record<string, string> = {
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      PLAYWRIGHT_SKIP_BROWSER_VALIDATION: "1",
    };

    if (!this.options.headless) {
      instructions.push(
        `RUN echo '#!/bin/sh' > /usr/local/bin/xvfb-exec`,
        `RUN echo 'Xvfb :99 -screen 0 1024x768x24 &' >> /usr/local/bin/xvfb-exec`,
        `RUN echo 'exec "$@"' >> /usr/local/bin/xvfb-exec`,
        `RUN chmod +x /usr/local/bin/xvfb-exec`
      );

      envVars.DISPLAY = ":99";
    }

    context.addLayer({
      id: "playwright",
      image: {
        instructions,
      },
      deploy: {
        env: envVars,
        override: true,
      },
    });
  }
}
