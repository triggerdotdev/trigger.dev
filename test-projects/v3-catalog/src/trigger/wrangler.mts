import { logger, task } from "@trigger.dev/sdk/v3";
import { exec } from "node:child_process";

export const wranglerTask = task({
  id: "wrangler-task",
  run: async () => {
    // Try and resolve wranger from the node_modules/.bin directory
    const wranglerPath = await import.meta.resolve?.("wrangler", import.meta.url);

    if (!wranglerPath) {
      throw new Error("Wrangler not found in node_modules directory");
    }

    logger.log(`Running wrangler from ${wranglerPath}`, {
      meta: import.meta,
    });

    // remove the file:// prefix
    const wranglerPathWithoutFilePrefix = wranglerPath.replace("file://", "");

    const version = await new Promise<string>((resolve, reject) => {
      exec(`node ${wranglerPathWithoutFilePrefix} --version`, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stdout.trim());
      });
    });

    return {
      version,
    };
  },
});
