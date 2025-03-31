import path from "node:path";
import { readFile } from "../utilities/fileSystem.js";
import { tryCatch } from "@trigger.dev/core/utils";
import { logger } from "../utilities/logger.js";
import { writeFile } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { onExit } from "signal-exit";

const LOCK_FILE_NAME = "dev.lock";

export async function createLockFile(cwd: string) {
  const currentPid = process.pid;
  const lockFilePath = path.join(cwd, ".trigger", LOCK_FILE_NAME);

  logger.debug("Checking for lockfile", { lockFilePath, currentPid });

  const removeLockFile = () => {
    try {
      logger.debug("Removing lockfile", { lockFilePath });
      return unlinkSync(lockFilePath);
    } catch (e) {
      // This sometimes fails on Windows with EBUSY
    }
  };
  const removeExitListener = onExit(removeLockFile);

  const [, existingLockfileContents] = await tryCatch(readFile(lockFilePath));

  if (existingLockfileContents) {
    // Read the pid number from the lockfile
    const existingPid = Number(existingLockfileContents);

    logger.debug("Lockfile exists", { lockFilePath, existingPid, currentPid });

    if (existingPid === currentPid) {
      logger.debug("Lockfile exists and is owned by current process", {
        lockFilePath,
        existingPid,
        currentPid,
      });

      return () => {
        removeExitListener();
        removeLockFile();
      };
    }

    // If the pid is different, try and kill the existing pid
    logger.debug("Lockfile exists and is owned by another process, killing it", {
      lockFilePath,
      existingPid,
      currentPid,
    });

    try {
      process.kill(existingPid);
      // If it did kill the process, it will have exited, deleting the lockfile, so let's wait for that to happen
      // But let's not wait forever
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(interval);
          reject(new Error("Timed out waiting for lockfile to be deleted"));
        }, 5000);

        const interval = setInterval(() => {
          if (!existsSync(lockFilePath)) {
            clearInterval(interval);
            clearTimeout(timeout);
            resolve(true);
          }
        }, 100);
      });
    } catch (error) {
      logger.debug("Failed to kill existing process, lets assume it's not running", { error });
    }
  }

  // Now write the current pid to the lockfile
  await writeFile(lockFilePath, currentPid.toString());

  logger.debug("Lockfile created", { lockFilePath, currentPid });

  return () => {
    removeExitListener();
    removeLockFile();
  };
}
