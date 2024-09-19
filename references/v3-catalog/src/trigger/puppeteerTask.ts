import { task } from "@trigger.dev/sdk/v3";
import puppeteer from "puppeteer";

export const puppeteerTask = task({
  id: "puppeteer-task",
  machine: {
    preset: "large-1x"
  },
  run: async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto("https://google.com");
    await page.screenshot({ path: "screenshot.png" });
    await browser.close();
  },
});
