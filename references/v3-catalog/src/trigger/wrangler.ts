import { logger, task } from "@trigger.dev/sdk/v3";
import { exec } from "node:child_process";
import { join } from "node:path";

const wranglerPath = join(__dirname, "node_modules", ".bin", "wrangler");

export const wranglerTask = task({
  id: "wrangler-task",
  run: async () => {
    logger.log(`Running wrangler from ${wranglerPath}`, {
      processEnv: process.env,
      cwd: process.cwd(),
    });

    const version = await new Promise<string>((resolve, reject) => {
      exec(`${wranglerPath} --version`, (error, stdout, stderr) => {
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
