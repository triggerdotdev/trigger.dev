import { spawn } from "node:child_process";
import { getHeapStatistics } from "node:v8";
import { logger } from "./logger.js";

const DEFAULT_MEMORY_LIMIT_MB = 4096;

/**
 * Ensures that the current Node process has enough memory to perform builds.
 * If not, it respawns the process with a larger heap size.
 * @returns true if the process is being respawned, false otherwise.
 */
export function ensureSufficientMemory(): boolean {
    if (process.env.TRIGGER_CLI_MEMORY_RESPAWNED === "1") {
        logger.debug("Already respawned with more memory, skipping check.");
        return false;
    }

    const heapStats = getHeapStatistics();
    const heapLimitMB = heapStats.heap_size_limit / 1024 / 1024;

    // If the limit is already 4GB or more, we're good
    if (heapLimitMB >= DEFAULT_MEMORY_LIMIT_MB) {
        logger.debug(`Current heap limit (${Math.round(heapLimitMB)}MB) is sufficient.`);
        return false;
    }

    // We only want to respawn for memory-intensive commands like deploy or dev
    const isMemoryIntensive =
        process.argv.includes("deploy") || process.argv.includes("dev") || process.argv.includes("build");

    if (!isMemoryIntensive) {
        return false;
    }

    logger.debug(
        `Increasing memory limit from ${Math.round(heapLimitMB)}MB to ${DEFAULT_MEMORY_LIMIT_MB}MB...`
    );

    const args = ["--max-old-space-size=4096", ...process.argv.slice(1)];

    const child = spawn(process.execPath, args, {
        stdio: "inherit",
        env: {
            ...process.env,
            TRIGGER_CLI_MEMORY_RESPAWNED: "1",
        },
    });

    child.on("exit", (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
        } else {
            process.exit(code ?? 0);
        }
    });

    return true;
}
