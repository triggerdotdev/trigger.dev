import { logger, task } from "@trigger.dev/sdk";
import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import puppeteer from "puppeteer-core";

const spawnLightpanda = async (host: string, port: string) =>
  new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
    const child = spawn("lightpanda", [
      "serve",
      "--host",
      host,
      "--port",
      port,
      "--log_level",
      "info",
    ]);

    child.on("spawn", async () => {
      logger.info("Running Lightpanda's CDP server…", {
        pid: child.pid,
      });

      await new Promise((resolve) => setTimeout(resolve, 250));
      resolve(child);
    });
    child.on("error", (e) => reject(e));
  });

export const lightpandaCdp = task({
  id: "lightpanda-cdp",
  machine: {
    preset: "micro",
  },
  run: async (payload: { url: string }, { ctx }) => {
    logger.log("Lets get a page's links with Lightpanda!", { payload, ctx });

    if (!payload.url) {
      logger.warn("Please define the payload url");
      throw new Error("payload.url is undefined");
    }

    const host = process.env.LIGHTPANDA_CDP_HOST ?? "127.0.0.1";
    const port = process.env.LIGHTPANDA_CDP_PORT ?? "9222";

    // Launch Lightpanda's CDP server
    const lpProcess = await spawnLightpanda(host, port);

    const browser = await puppeteer.connect({
      browserWSEndpoint: `ws://${host}:${port}`,
    });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    // Dump all the links from the page.
    await page.goto(payload.url);

    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a")).map((row) => {
        return row.getAttribute("href");
      });
    });

    logger.info("Processing done");
    logger.info("Shutting down…");

    // Close Puppeteer instance
    await browser.close();

    // Stop Lightpanda's CDP Server
    lpProcess.kill();

    logger.info("✅ Completed");

    return {
      links,
    };
  },
});

export const lightpandaFetch = task({
  id: "lightpanda-fetch",
  machine: {
    preset: "micro",
  },
  run: async (payload: { url: string }, { ctx }) => {
    logger.log("Lets get a page's content with Lightpanda!", { payload, ctx });

    if (!payload.url) {
      logger.warn("Please define the payload url");
      throw new Error("payload.url is undefined");
    }

    const buffer = execSync(`lightpanda fetch --dump ${payload.url}`);

    logger.info("✅ Completed");

    return {
      message: buffer.toString(),
    };
  },
});

export const lightpandaCloudPuppeteer = task({
  id: "lightpanda-cloud-puppeteer",
  machine: {
    preset: "micro",
  },
  run: async (payload: { url: string }, { ctx }) => {
    logger.log("Lets get a page's links with Lightpanda!", { payload, ctx });

    if (!payload.url) {
      logger.warn("Please define the payload url");
      throw new Error("payload.url is undefined");
    }

    const token = process.env.LIGHTPANDA_TOKEN;
    if (!token) {
      logger.warn("Please define the env variable LIGHTPANDA_TOKEN");
      throw new Error("LIGHTPANDA_TOKEN is undefined");
    }

    // Connect to Lightpanda's cloud
    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://cloud.lightpanda.io/ws?browser=lightpanda&token=${token}`,
    });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    // Dump all the links from the page.
    await page.goto(payload.url);

    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a")).map((row) => {
        return row.getAttribute("href");
      });
    });

    logger.info("Processing done, shutting down…");

    await page.close();
    await context.close();
    await browser.disconnect();

    logger.info("✅ Completed");

    return {
      links,
    };
  },
});
