import { spinner, confirm } from "@clack/prompts";
import { getUserPackageManager, type PackageManager } from "./getUserPackageManager";
import { logger } from "./logger";
import chalk from "chalk";
import { execa } from "execa";

export async function installDependencies(projectDir: string) {
  logger.info("Installing dependencies...");

  const pkgManager = await getUserPackageManager(projectDir);

  const installSpinner = await runInstallCommand(pkgManager, projectDir);

  // If the spinner was used to show the progress, use succeed method on it
  // If not, use the succeed on a new spinner
  (installSpinner || spinner()).stop(chalk.green("Successfully installed dependencies!\n"));
}

async function runInstallCommand(
  pkgManager: PackageManager,
  projectDir: string
): Promise<ReturnType<typeof spinner> | null> {
  switch (pkgManager) {
    // When using npm, inherit the stderr stream so that the progress bar is shown
    case "npm":
      await execa(pkgManager, ["install"], {
        cwd: projectDir,
        stderr: "inherit",
      });

      return null;
    // When using yarn or pnpm, use the stdout stream and ora spinner to show the progress
    case "pnpm": {
      const loadingSpinner = spinner();
      loadingSpinner.start("Running pnpm install...");
      const pnpmSubprocess = execa(pkgManager, ["install"], {
        cwd: projectDir,
        stdout: "pipe",
      });

      await new Promise<void>((res, rej) => {
        pnpmSubprocess.stdout?.on("data", (data: Buffer) => {
          const text = data.toString();

          if (text.includes("Progress")) {
            loadingSpinner.message(text.includes("|") ? text.split(" | ")[1] ?? "" : text);
          }
        });
        pnpmSubprocess.on("error", (e) => rej(e));
        pnpmSubprocess.on("close", () => res());
      });

      return loadingSpinner;
    }
    case "yarn": {
      const loadingSpinner = spinner();
      loadingSpinner.start("Running yarn...");
      const yarnSubprocess = execa(pkgManager, [], {
        cwd: projectDir,
        stdout: "pipe",
      });

      await new Promise<void>((res, rej) => {
        yarnSubprocess.stdout?.on("data", (data: Buffer) => {
          loadingSpinner.message(data.toString());
        });
        yarnSubprocess.on("error", (e) => rej(e));
        yarnSubprocess.on("close", () => res());
      });

      return loadingSpinner;
    }
  }
}
