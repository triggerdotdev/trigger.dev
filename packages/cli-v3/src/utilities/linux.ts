import { spawn } from "child_process";
import { logger } from "./logger.js";

export const isLinuxServer = async () => {
  if (process.platform !== "linux") {
    return false;
  }

  const xdgAvailable = await new Promise<boolean>((res) => {
    const xdg = spawn("xdg-open");

    xdg.on("error", (error) => {
      logger.debug("Error while checking for xdg-open", error);
      res(false);
    });

    xdg.on("spawn", () => {
      res(true);
    });

    xdg.on("exit", (code) => {
      res(code === 0);
    });

    xdg.unref();
  });

  logger.debug("xdg-open available:", xdgAvailable);

  return !xdgAvailable;
};
