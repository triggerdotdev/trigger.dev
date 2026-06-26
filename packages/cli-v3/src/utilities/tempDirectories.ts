import fs from "node:fs";
import path from "node:path";
import { onExit } from "signal-exit";
import { devBranchPathSegment } from "./devBranch.js";

/**
 * Resolves the `.trigger/tmp` root for a dev session, scoped to the branch so
 * concurrent sessions on different branches don't share (and clobber) a build
 * tree. The default branch keeps the original `.trigger/tmp` path; branches get
 * a sibling root (e.g. `.trigger/tmp-feature-foo`) so a default-branch
 * `clearTmpDirs` can't reach into a branch's tree, and vice versa.
 */
export function getTmpRoot(projectRoot: string | undefined, branch?: string): string {
  projectRoot ??= process.cwd();
  const safeBranch = devBranchPathSegment(branch);
  const tmpDirName = safeBranch ? `tmp-${safeBranch}` : "tmp";
  return path.join(projectRoot, ".trigger", tmpDirName);
}

/**
 * A short-lived directory. Automatically removed when the process exits, but
 * can be removed earlier by calling `remove()`.
 */
export interface EphemeralDirectory {
  path: string;
  remove(): void;
}

/**
 * Gets a temporary directory in the project's `.trigger` folder with the
 * specified prefix. We create temporary directories in `.trigger` as opposed
 * to the OS's temporary directory to avoid issues with different drive letters
 * on Windows. For example, when `esbuild` outputs a file to a different drive
 * than the input sources, the generated source maps are incorrect.
 */
export function getTmpDir(
  projectRoot: string | undefined,
  prefix: string,
  keep: boolean = false,
  branch?: string
): EphemeralDirectory {
  const tmpRoot = getTmpRoot(projectRoot, branch);
  fs.mkdirSync(tmpRoot, { recursive: true });

  const tmpPrefix = path.join(tmpRoot, `${prefix}-`);
  const tmpDir = fs.realpathSync(fs.mkdtempSync(tmpPrefix));

  const removeDir = () => {
    try {
      return fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      // This sometimes fails on Windows with EBUSY
    }
  };
  const removeExitListener = keep || process.env.KEEP_TMP_DIRS ? () => {} : onExit(removeDir);

  return {
    path: tmpDir,
    remove() {
      removeExitListener();
      removeDir();
    },
  };
}

export function clearTmpDirs(projectRoot: string | undefined, branch?: string) {
  const tmpRoot = getTmpRoot(projectRoot, branch);

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) {
    // This sometimes fails on Windows with EBUSY
  }
}

/**
 * Gets the shared store directory for content-addressable build outputs.
 * This directory persists across rebuilds and is used to deduplicate
 * identical chunk files between build versions.
 * Automatically cleaned up when the process exits.
 */
export function getStoreDir(
  projectRoot: string | undefined,
  keep: boolean = false,
  branch?: string
): string {
  const storeDir = path.join(getTmpRoot(projectRoot, branch), "store");
  fs.mkdirSync(storeDir, { recursive: true });

  // Register exit handler to clean up the store directory
  if (!keep && !process.env.KEEP_TMP_DIRS) {
    onExit(() => {
      try {
        fs.rmSync(storeDir, { recursive: true, force: true });
      } catch (e) {
        // This sometimes fails on Windows with EBUSY
      }
    });
  }

  return storeDir;
}
