import type { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import type { BuildManifest, BuildTarget } from "@trigger.dev/core/v3";

type PlaywrightBrowser = "chromium" | "firefox" | "webkit";

interface PlaywrightExtensionOptions {
  /**
   * Browsers to install. Select only needed browsers to optimize build time and size.
   * @default ["chromium"]
   */
  browsers?: PlaywrightBrowser[];

  /**
   * Run the browsers in headless mode (Recommended)
   * @default true
   */
  headless?: boolean;

  /**
   * Playwright version override. If not provided, we will try to detect the version automatically.
   */
  version?: string;
}

/**
 * This list is from the official playwright registry.
 *
 * @see https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/registry/nativeDeps.ts
 */
const debian12Deps = {
  tools: [
    "xvfb",
    "fonts-noto-color-emoji",
    "fonts-unifont",
    "libfontconfig1",
    "libfreetype6",
    "xfonts-scalable",
    "fonts-liberation",
    "fonts-ipafont-gothic",
    "fonts-wqy-zenhei",
    "fonts-tlwg-loma-otf",
    "fonts-freefont-ttf",
  ],
  chromium: [
    "libasound2",
    "libatk-bridge2.0-0",
    "libatk1.0-0",
    "libatspi2.0-0",
    "libcairo2",
    "libcups2",
    "libdbus-1-3",
    "libdrm2",
    "libgbm1",
    "libglib2.0-0",
    "libnspr4",
    "libnss3",
    "libpango-1.0-0",
    "libx11-6",
    "libxcb1",
    "libxcomposite1",
    "libxdamage1",
    "libxext6",
    "libxfixes3",
    "libxkbcommon0",
    "libxrandr2",
  ],
  firefox: [
    "libasound2",
    "libatk1.0-0",
    "libcairo-gobject2",
    "libcairo2",
    "libdbus-1-3",
    "libdbus-glib-1-2",
    "libfontconfig1",
    "libfreetype6",
    "libgdk-pixbuf-2.0-0",
    "libglib2.0-0",
    "libgtk-3-0",
    "libharfbuzz0b",
    "libpango-1.0-0",
    "libpangocairo-1.0-0",
    "libx11-6",
    "libx11-xcb1",
    "libxcb-shm0",
    "libxcb1",
    "libxcomposite1",
    "libxcursor1",
    "libxdamage1",
    "libxext6",
    "libxfixes3",
    "libxi6",
    "libxrandr2",
    "libxrender1",
    "libxtst6",
  ],
  webkit: [
    "libsoup-3.0-0",
    "gstreamer1.0-libav",
    "gstreamer1.0-plugins-bad",
    "gstreamer1.0-plugins-base",
    "gstreamer1.0-plugins-good",
    "libatk-bridge2.0-0",
    "libatk1.0-0",
    "libcairo2",
    "libdbus-1-3",
    "libdrm2",
    "libegl1",
    "libenchant-2-2",
    "libepoxy0",
    "libevdev2",
    "libfontconfig1",
    "libfreetype6",
    "libgbm1",
    "libgdk-pixbuf-2.0-0",
    "libgles2",
    "libglib2.0-0",
    "libglx0",
    "libgstreamer-gl1.0-0",
    "libgstreamer-plugins-base1.0-0",
    "libgstreamer1.0-0",
    "libgtk-4-1",
    "libgudev-1.0-0",
    "libharfbuzz-icu0",
    "libharfbuzz0b",
    "libhyphen0",
    "libicu72",
    "libjpeg62-turbo",
    "liblcms2-2",
    "libmanette-0.2-0",
    "libnotify4",
    "libopengl0",
    "libopenjp2-7",
    "libopus0",
    "libpango-1.0-0",
    "libpng16-16",
    "libproxy1v5",
    "libsecret-1-0",
    "libwayland-client0",
    "libwayland-egl1",
    "libwayland-server0",
    "libwebp7",
    "libwebpdemux2",
    "libwoff1",
    "libx11-6",
    "libxcomposite1",
    "libxdamage1",
    "libxkbcommon0",
    "libxml2",
    "libxslt1.1",
    "libatomic1",
    "libevent-2.1-7",
    "libavif15",
  ],
  lib2package: {
    "libavif.so.15": "libavif15",
    "libsoup-3.0.so.0": "libsoup-3.0-0",
    "libasound.so.2": "libasound2",
    "libatk-1.0.so.0": "libatk1.0-0",
    "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0",
    "libatspi.so.0": "libatspi2.0-0",
    "libcairo.so.2": "libcairo2",
    "libcups.so.2": "libcups2",
    "libdbus-1.so.3": "libdbus-1-3",
    "libdrm.so.2": "libdrm2",
    "libgbm.so.1": "libgbm1",
    "libgio-2.0.so.0": "libglib2.0-0",
    "libglib-2.0.so.0": "libglib2.0-0",
    "libgobject-2.0.so.0": "libglib2.0-0",
    "libnspr4.so": "libnspr4",
    "libnss3.so": "libnss3",
    "libnssutil3.so": "libnss3",
    "libpango-1.0.so.0": "libpango-1.0-0",
    "libsmime3.so": "libnss3",
    "libX11.so.6": "libx11-6",
    "libxcb.so.1": "libxcb1",
    "libXcomposite.so.1": "libxcomposite1",
    "libXdamage.so.1": "libxdamage1",
    "libXext.so.6": "libxext6",
    "libXfixes.so.3": "libxfixes3",
    "libxkbcommon.so.0": "libxkbcommon0",
    "libXrandr.so.2": "libxrandr2",
    "libgtk-4.so.1": "libgtk-4-1",
  },
};

/**
 * Creates a Playwright extension for trigger.dev
 * @param options Configuration options
 */
export function playwright(options: PlaywrightExtensionOptions = {}) {
  return new PlaywrightExtension(options);
}

/**
 * Background:
 *
 * Running `npx playwright install --with-deps` normally will install the browsers and the dependencies.
 * However, this is not possible in a build context, because we don't have sudo access.
 *
 * So we need to install the dependencies manually and then download and install the browsers.
 * This has a few challenges:
 * 1. We don't want to download all browsers, only the ones we need with it's dependencies
 *    The less dependencies we have to install, the faster the build, and the smaller the image.
 * 2. We need to know where to download the browsers from
 *    while we can hardcode the download url it might change over time (as it has in the past)
 *    so we need to download the browser info first and then parse the output to get the download url.
 *
 * Note: While this looks like we are downloading & installing a lot of stuff, it's actually not that bad
 *       since running `npx playwright install --with-deps` will result in the same amount of downloads.
 */
class PlaywrightExtension implements BuildExtension {
  public readonly name = "PlaywrightExtension";
  private moduleExternals: string[];

  private readonly options: Required<Omit<PlaywrightExtensionOptions, "version">> & {
    version?: string;
  };

  constructor({
    browsers = ["chromium"],
    headless = true,
    version,
  }: PlaywrightExtensionOptions = {}) {
    if (browsers && browsers.length === 0) {
      throw new Error("At least one browser must be specified");
    }
    this.options = { browsers, headless, version };
    this.moduleExternals = ["playwright"];
  }

  externalsForTarget(target: BuildTarget) {
    if (target === "dev") {
      return [];
    }

    return this.moduleExternals;
  }

  onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === "dev") return;

    // Detect Playwright version from manifest.externals or use override
    const playwrightExternal = manifest.externals?.find(
      (external: any) => external.name === "playwright" || external.name === "@playwright/test"
    );
    const version = playwrightExternal?.version ?? this.options.version;

    if (!version) {
      throw new Error(
        "PlaywrightExtension could not determine the version of playwright. Please provide a version in the PlaywrightExtension options."
      );
    }

    context.logger.debug(
      `Adding ${this.name} to the build with browsers: ${this.options.browsers.join(
        ", "
      )}, version: ${version}`
    );

    const instructions: string[] = [
      // Base dependencies, we need these to download the browsers
      `RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        unzip \
        jq \
        grep \
        sed \
        npm \
        && apt-get clean && rm -rf /var/lib/apt/lists/*`,

      // Install Playwright globally with detected version
      `RUN npm install -g playwright@${version}`,
    ];

    const deps = [...debian12Deps.tools, ...Object.values(debian12Deps.lib2package)];
    if (this.options.browsers.includes("chromium")) deps.push(...debian12Deps.chromium);
    if (this.options.browsers.includes("firefox")) deps.push(...debian12Deps.firefox);
    if (this.options.browsers.includes("webkit")) deps.push(...debian12Deps.webkit);

    instructions.push(
      `RUN apt-get update && apt-get install -y --no-install-recommends ${deps.join(" ")} \
        && apt-get clean && rm -rf /var/lib/apt/lists/*`
    );

    // Setup directory for playwright browsers
    instructions.push(`RUN mkdir -p /ms-playwright`);

    /**
     * `npx playwright install --dry-run` prints the download urls for the browsers.
     * We save this output to a file and then parse it to get the download urls for the browsers.
     */
    instructions.push(`RUN npx playwright install --dry-run > /tmp/browser-info.txt`);
    this.options.browsers.forEach((browser) => {
      const browserType = browser === "chromium" ? "chromium-headless-shell" : browser;
      instructions.push(
        `RUN grep -A5 "browser: ${browserType}" /tmp/browser-info.txt > /tmp/${browser}-info.txt`,

        `RUN INSTALL_DIR=$(grep "Install location:" /tmp/${browser}-info.txt | cut -d':' -f2- | xargs) && \
          DIR_NAME=$(basename "$INSTALL_DIR") && \
          if [ -z "$DIR_NAME" ]; then echo "Failed to extract installation directory for ${browser}"; exit 1; fi && \
          MS_DIR="/ms-playwright/$DIR_NAME" && \
          mkdir -p "$MS_DIR"`,

        `RUN DOWNLOAD_URL=$(grep "Download url:" /tmp/${browser}-info.txt | cut -d':' -f2- | xargs | sed "s/mac-arm64/linux/g" | sed "s/mac-15-arm64/ubuntu-20.04/g") && \
          if [ -z "$DOWNLOAD_URL" ]; then echo "Failed to extract download URL for ${browser}"; exit 1; fi && \
          echo "Downloading ${browser} from $DOWNLOAD_URL" && \
          curl -L -o /tmp/${browser}.zip "$DOWNLOAD_URL" && \
          if [ $? -ne 0 ]; then echo "Failed to download ${browser}"; exit 1; fi && \
          unzip -q /tmp/${browser}.zip -d "/ms-playwright/$(basename $(grep "Install location:" /tmp/${browser}-info.txt | cut -d':' -f2- | xargs))" && \
          if [ $? -ne 0 ]; then echo "Failed to extract ${browser}"; exit 1; fi && \
          chmod -R +x "/ms-playwright/$(basename $(grep "Install location:" /tmp/${browser}-info.txt | cut -d':' -f2- | xargs))" && \
          rm /tmp/${browser}.zip`
      );
    });

    // Environment variables
    const envVars: Record<string, string> = {
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright", // where playwright will find the browsers
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", // we already downloaded the browsers
      PLAYWRIGHT_SKIP_BROWSER_VALIDATION: "1", // we already downloaded the browsers
    };

    if (!this.options.headless) {
      instructions.push(
        `RUN echo '#!/bin/sh' > /usr/local/bin/xvfb-exec`,
        `RUN echo 'Xvfb :99 -screen 0 1024x768x24 &' >> /usr/local/bin/xvfb-exec`,
        `RUN echo 'exec "$@"' >> /usr/local/bin/xvfb-exec`,
        `RUN chmod +x /usr/local/bin/xvfb-exec`
      );

      envVars.DISPLAY = ":99"; // Virtual display for the browsers
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
      dependencies: {
        playwright: version,
      },
    });
  }
}
