/**
 * Dev Watchdog — a detached process that cancels in-flight runs when the dev CLI exits.
 *
 * Spawned by the dev CLI with `detached: true, stdio: "ignore", unref()`.
 * Survives when pnpm sends SIGKILL to the CLI process tree.
 *
 * Lifecycle:
 *   1. CLI spawns this script, passing config via env vars
 *   2. Writes PID file for single-instance guarantee
 *   3. Polls parent PID to detect when the CLI exits
 *   4. On parent death: reads active-runs file → calls disconnect endpoint → exits
 *
 * Environment variables:
 *   WATCHDOG_PARENT_PID    - The PID of the parent dev CLI process
 *   WATCHDOG_API_URL       - The Trigger.dev API/engine URL
 *   WATCHDOG_API_KEY       - The API key for authentication
 *   WATCHDOG_ACTIVE_RUNS   - Path to the active-runs JSON file
 *   WATCHDOG_PID_FILE      - Path to write the watchdog PID file
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
// @crumbs - watchdog runs as detached process, trail imported directly
let crumb: (msg: string, data?: Record<string, unknown>) => void = () => {}; // @crumbs
try { const { trail } = await import("agentcrumbs"); crumb = trail("cli"); } catch {} // @crumbs

const POLL_INTERVAL_MS = 1000;

// Safety timeout: if the watchdog has been running for 24 hours, exit regardless.
// Prevents zombie watchdogs from PID reuse scenarios.
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

const parentPid = parseInt(process.env.WATCHDOG_PARENT_PID!, 10);
const apiUrl = process.env.WATCHDOG_API_URL!;
const apiKey = process.env.WATCHDOG_API_KEY!;
const activeRunsPath = process.env.WATCHDOG_ACTIVE_RUNS!;
const pidFilePath = process.env.WATCHDOG_PID_FILE!;
const tmpDir = process.env.WATCHDOG_TMP_DIR;

if (!parentPid || !apiUrl || !apiKey || !activeRunsPath || !pidFilePath) {
  process.exit(1);
}

// Ensure directory exists
const dir = dirname(pidFilePath);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const PID_FILE_PREFIX = "trigger-watchdog:";

// Single instance: kill any existing watchdog
try {
  const pidFileContent = readFileSync(pidFilePath, "utf8");
  if (pidFileContent.startsWith(PID_FILE_PREFIX)) {
    const existingPid = parseInt(pidFileContent.slice(PID_FILE_PREFIX.length), 10);
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // Check if alive
        process.kill(existingPid, "SIGTERM"); // Kill it
      } catch {
        // Already dead
      }
    }
  }
} catch {
  // No PID file or invalid format
}

// Write our PID with prefix so we can verify ownership later
writeFileSync(pidFilePath, `${PID_FILE_PREFIX}${process.pid}`);

function cleanup() {
  try {
    unlinkSync(pidFilePath);
  } catch {}
  try {
    unlinkSync(activeRunsPath);
  } catch {}
}

function cleanupTmpDir() {
  if (!tmpDir) return;
  crumb("watchdog: cleaning up tmp dir", { tmpDir }); // @crumbs
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    crumb("watchdog: tmp dir removed", { tmpDir }); // @crumbs
  } catch {
    crumb("watchdog: tmp dir cleanup failed", { tmpDir }); // @crumbs
    // Best effort — may fail on Windows with EBUSY
  }
}

function isParentAlive(): boolean {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

function readActiveRuns(): string[] {
  try {
    const data = JSON.parse(readFileSync(activeRunsPath, "utf8"));
    return data.runFriendlyIds ?? [];
  } catch {
    return [];
  }
}

async function callDisconnect(runFriendlyIds: string[]): Promise<void> {
  const response = await fetch(`${apiUrl}/engine/v1/dev/disconnect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ runFriendlyIds }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Disconnect failed with status ${response.status}`);
  }
}

const MAX_DISCONNECT_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 500;

async function onParentDied(): Promise<void> {
  crumb("watchdog: parent died", { parentPid, tmpDir }); // @crumbs
  const runFriendlyIds = readActiveRuns();

  if (runFriendlyIds.length > 0) {
    for (let attempt = 0; attempt < MAX_DISCONNECT_ATTEMPTS; attempt++) {
      try {
        await callDisconnect(runFriendlyIds);
        break;
      } catch {
        if (attempt < MAX_DISCONNECT_ATTEMPTS - 1) {
          const backoff = INITIAL_BACKOFF_MS * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
        // Final attempt failed — runs will eventually time out via heartbeat
      }
    }
  }

  cleanupTmpDir();
  cleanup();
  process.exit(0);
}

// Guard against overlapping async callbacks
let checking = false;

const interval = setInterval(async () => {
  if (checking) return;
  checking = true;

  try {
    if (!isParentAlive()) {
      clearInterval(interval);
      clearTimeout(lifetimeTimeout);
      await onParentDied();
    }
  } finally {
    checking = false;
  }
}, POLL_INTERVAL_MS);

// Safety timeout: exit after MAX_LIFETIME_MS to prevent zombie watchdogs
const lifetimeTimeout = setTimeout(() => {
  clearInterval(interval);
  cleanup();
  process.exit(0);
}, MAX_LIFETIME_MS);

// Unref the timeout so it doesn't keep the process alive if the interval is cleared
lifetimeTimeout.unref();

// Clean exit on any termination signal
function handleSignal() {
  clearInterval(interval);
  clearTimeout(lifetimeTimeout);
  cleanup();
  process.exit(0);
}

process.on("SIGTERM", handleSignal);
process.on("SIGINT", handleSignal);
