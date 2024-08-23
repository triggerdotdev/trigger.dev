import fs from "node:fs";
import path from "node:path";
import { onExit } from "signal-exit";

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
  keep: boolean = false
): EphemeralDirectory {
  projectRoot ??= process.cwd();
  const tmpRoot = path.join(projectRoot, ".trigger", "tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });

  const tmpPrefix = path.join(tmpRoot, `${prefix}-`);
  const tmpDir = fs.realpathSync(fs.mkdtempSync(tmpPrefix));

  let removeDir = keep ? () => {} : () => fs.rmSync(tmpDir, { recursive: true, force: true });
  let removeExitListener = keep ? () => {} : onExit(removeDir);

  return {
    path: tmpDir,
    remove() {
      removeExitListener();
      removeDir();
    },
  };
}
