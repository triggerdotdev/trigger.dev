import * as fs from "node:fs";
import * as path from "node:path";

/** Walks up from `start` to the pnpm workspace root the guard scripts resolve paths against. */
export function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error("Could not locate repo root (pnpm-workspace.yaml not found)");
    dir = parent;
  }
}
