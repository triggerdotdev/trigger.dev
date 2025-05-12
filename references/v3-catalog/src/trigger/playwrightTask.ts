import { logger, task } from "@trigger.dev/sdk/v3";
import { chromium } from "playwright";
/**
 * Example task demonstrating Playwright browser automation with Trigger.dev
 *
 * To use other browsers (firefox, webkit):
 * 1. Import them from playwright: `import { chromium, firefox, webkit } from "playwright";`
 * 2. Add them to the browserType array: `for (const browserType of [chromium, firefox, webkit])`
 * 3. Configure the playwright extension in your project:
 *    ```
 *    // In your build configuration
 *    import { playwright } from "@trigger.dev/core/v3/build";
 *
 *    extensions: [
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

    for (const browserType of [chromium]) {
      const prefix = (msg: string) => `[${browserType.name()}]: ${msg}`;

      const browser = await browserType.launch();
      logger.log(prefix("Browser launched"));

      const page = await browser.newPage();
      logger.log(prefix("New page created"));

      await page.goto("https://google.com");
      logger.log(prefix("Navigated to google.com"));

      const screenshot = await page.screenshot({ path: "screenshot.png" });
      logger.log(prefix("Screenshot taken"), { size: screenshot.byteLength });

      await browser.close();
      logger.log(prefix("Browser closed"));
    }
  },
});
