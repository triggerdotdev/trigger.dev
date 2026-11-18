import type { BuildManifest } from "@trigger.dev/core/v3/schemas";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, sep, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteOutputPath, writeContainerfile } from "./buildWorker.js";

describe("rewriteOutputPath", () => {
  it("defaults to the host platform's path semantics", () => {
    const out = join(sep, "tmp", "out");
    expect(rewriteOutputPath(out, join(out, "src", "a b.mjs"))).toBe("/app/src/a b.mjs");
  });

  it("maps a bundled file to its /app path on posix", () => {
    expect(rewriteOutputPath("/tmp/out", "/tmp/out/src/trigger/a.mjs", posix)).toBe(
      "/app/src/trigger/a.mjs"
    );
  });

  it("uses forward slashes and keeps spaces and non-ASCII characters on windows", () => {
    const out = "C:\\Users\\me\\AppData\\Local\\Temp\\trigger-build";
    const file = `${out}\\Documents\\DATEN VORBEREITUNG FÜR AUKTIONEN\\trigger.config.mjs`;

    expect(rewriteOutputPath(out, file, win32)).toBe(
      "/app/Documents/DATEN VORBEREITUNG FÜR AUKTIONEN/trigger.config.mjs"
    );
  });

  it("tolerates mixed separators and drive letter case on windows", () => {
    expect(
      rewriteOutputPath("c:\\Users\\me\\out", "C:/Users/me/out/Trigger Demo/index.mjs", win32)
    ).toBe("/app/Trigger Demo/index.mjs");
  });
});

describe("writeContainerfile", () => {
  // Catches: a task file left out of the compiled worker, which then can't import it, the
  // compile running before build extension commands that generate files it bundles, or embedded
  // files renamed to .js so the import.meta banner points at a file that isn't on disk
  it("compiles every module the run worker imports, after the build commands", async () => {
    const outputPath = await mkdtemp(join(tmpdir(), "trigger-containerfile-"));

    try {
      await writeContainerfile(outputPath, {
        runtime: "bun-1.4",
        runControllerEntryPoint: "/app/run-controller.mjs",
        indexControllerEntryPoint: "/app/index-controller.mjs",
        runWorkerEntryPoint: "/app/run-worker.mjs",
        configPath: "/app/trigger.config.mjs",
        initEntryPoint: "/app/src/trigger/init.mjs",
        files: [
          { entry: "src/trigger/a.ts", out: "/app/src/trigger/a.mjs" },
          { entry: "src/trigger/b.ts", out: "/app/src/trigger/b.mjs" },
        ],
        compiledRunWorkerPath: "/app/.trigger/worker/run-worker",
        build: { commands: ["generate-client"] },
      } as unknown as BuildManifest);

      const containerfile = await readFile(join(outputPath, "Containerfile"), "utf8");
      const compileLine = containerfile.split("\n").find((line) => line.includes('"--compile"'));

      expect(compileLine).toBeDefined();
      const args = JSON.parse(compileLine!.slice("RUN ".length)) as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          "--entry-naming=[dir]/[name].mjs",
          "--outfile=/app/.trigger/worker/run-worker",
          "/app/run-worker.mjs",
          "/app/trigger.config.mjs",
          "/app/src/trigger/init.mjs",
          "/app/src/trigger/a.mjs",
          "/app/src/trigger/b.mjs",
        ])
      );
      expect(containerfile.indexOf("RUN generate-client")).toBeGreaterThan(-1);
      expect(containerfile.indexOf("RUN generate-client")).toBeLessThan(
        containerfile.indexOf(compileLine!)
      );
    } finally {
      await rm(outputPath, { recursive: true, force: true });
    }
  });
});
