import { logger, task, locals, tasks, wait } from "@trigger.dev/sdk";
import { chromium, type Browser } from "playwright";

/**
 * Example task demonstrating Playwright browser automation with Trigger.dev
 *
 * To use other browsers (firefox, webkit):
 * 1. Import them from playwright: `import { chromium, firefox, webkit } from "playwright";`
 * 2. Launch them in the middleware instead of chromium: `const browser = await firefox.launch();`
 * 3. Configure the playwright extension in your project:
 *    ```
 *    // In your build configuration
 *    import { playwright } from "@trigger.dev/core/v3/build";
 *
 *    extensions: [
 *      // Only add browsers your tasks will use
 *      playwright({ browsers: ["chromium", "firefox", "webkit"] })
 *    ]
 *    ```
 */

export const playwrightTestTask = task({
  id: "playwright-test",
  retry: {
    maxAttempts: 1,
  },
  run: async () => {
    const playwrightVersion = require("playwright/package.json").version;

    logger.log("Starting Playwright automation task", { version: playwrightVersion });

    // Use the browser from locals
    const browser = getBrowser();
    const prefix = getPrefixFn(browser);

    logger.log(prefix("Browser acquired from locals"));

    // The onWait lifecycle hook will automatically close the browser
    // This ensures that checkpoint and restore will be successful
    await wait.for({ seconds: 10 });

    // We have to get a new browser instance because the existing one was closed
    const newBrowser = getBrowser();

    logger.log(prefix("New browser acquired from locals"));

    const page = await newBrowser.newPage();
    logger.log(prefix("New page created"));

    await page.goto("https://google.com");
    logger.log(prefix("Navigated to google.com"));

    const screenshot = await page.screenshot({ path: "screenshot.png" });
    logger.log(prefix("Screenshot taken"), { size: screenshot.byteLength });

    await page.close();
    logger.log(prefix("Page closed"));
  },
});

const getPrefixFn = (browser: Browser) => {
  const browserType = browser.browserType();
  const browserName = browserType.name();
  return (msg: string) => `[${browserName}]: ${msg}`;
};

// Locals key for Playwright browser
const PlaywrightBrowserLocal = locals.create<{ browser: Browser }>("playwright-browser");

export function getBrowser() {
  return locals.getOrThrow(PlaywrightBrowserLocal).browser;
}

export function setBrowser(browser: Browser) {
  locals.set(PlaywrightBrowserLocal, { browser });
}

tasks.middleware("playwright-browser", async ({ ctx, payload, task, next }) => {
  // Only using chromium for now, can be extended for other browsers
  const browser = await chromium.launch();
  setBrowser(browser);

  const prefix = getPrefixFn(browser);
  logger.log(prefix("Browser launched (middleware)"));

  try {
    await next();
  } finally {
    await browser.close();
    logger.log(prefix("Browser closed (middleware)"));
  }
});

tasks.onWait("playwright-browser", async ({ ctx, payload, task }) => {
  const browser = getBrowser();
  const prefix = getPrefixFn(browser);

  await browser.close();
  logger.log(prefix("Browser closed (onWait)"));
});

tasks.onResume("playwright-browser", async ({ ctx, payload, task }) => {
  // Only using chromium for now, can be extended for other browsers
  // Make sure this is the same browser as the one used in the middleware
  const browser = await chromium.launch();
  setBrowser(browser);

  const prefix = getPrefixFn(browser);
  logger.log(prefix("Browser launched (onResume)"));
});
