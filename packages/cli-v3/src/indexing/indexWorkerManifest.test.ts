import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { indexWorkerManifest } from "./indexWorkerManifest.js";

describe("indexWorkerManifest", () => {
  // Catches: a missing Bun binary crashing `trigger dev` and `trigger deploy` with an unhandled
  // spawn ENOENT instead of rejecting, so callers can report or skip it
  it("rejects with a readable error when the bun binary can't be started", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trigger-index-"));
    vi.stubEnv("BUN_INSTALL", join(dir, "no-bun-here"));

    try {
      await expect(
        indexWorkerManifest({
          runtime: "bun-1.4",
          indexWorkerPath: join(dir, "index-worker.mjs"),
          buildManifestPath: join(dir, "build.json"),
          env: { PATH: process.env.PATH },
          cwd: dir,
        })
      ).rejects.toThrow(/bun runtimes need Bun installed locally/);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
