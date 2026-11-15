import type { ResolvedConfig } from "@trigger.dev/core/v3/build";
import type { BuildRuntime, BuildTarget } from "@trigger.dev/core/v3/schemas";
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_IMAGE, bunCompileArgs } from "../deploy/buildImage.js";
import {
  type BundleResult,
  createBuildManifestFromBundle,
  createBuildOptions,
  getBundleResultFromBuild,
} from "./bundle.js";

const bundle = {
  contentHash: "hash",
  files: [],
  configPath: "/out/trigger.config.mjs",
  runWorkerEntryPoint: "/out/run-worker.mjs",
  runControllerEntryPoint: "/out/run-controller.mjs",
  indexWorkerEntryPoint: "/out/index-worker.mjs",
  indexControllerEntryPoint: "/out/index-controller.mjs",
} as unknown as BundleResult;

function configFor(runtime: BuildRuntime, bunBytecode?: boolean) {
  return {
    runtime,
    project: "proj",
    dirs: [],
    workingDir: "/project",
    build: { conditions: [], bunBytecode },
  } as unknown as ResolvedConfig;
}

function manifestFor(runtime: BuildRuntime, target: BuildTarget, bunBytecode?: boolean) {
  return createBuildManifestFromBundle({
    bundle,
    destination: "/out",
    resolvedConfig: configFor(runtime, bunBytecode),
    environment: "prod",
    target,
  });
}

describe("createBuildManifestFromBundle", () => {
  // Catches: a Bun 1.3 deploy getting a compile step its bun can't build, or the opt-out being ignored
  it.each([
    ["bun-1.4", "deploy", undefined, "/out/.trigger/worker/run-worker"],
    ["bun-1.4", "deploy", false, undefined],
    ["bun-1.4", "dev", undefined, undefined],
    ["bun-legacy", "deploy", undefined, undefined],
    ["bun", "deploy", undefined, undefined],
    ["node-24", "deploy", undefined, undefined],
  ] as const)(
    "%s %s with bunBytecode %s compiles the run worker to %s",
    async (runtime, target, bunBytecode, expected) => {
      const manifest = await manifestFor(runtime, target, bunBytecode);

      expect(manifest.compiledRunWorkerPath).toBe(expected);
    }
  );
});

describe("createBuildOptions", () => {
  // Catches: the compiled worker banner left off a compiled deploy, or added to bundles that run from disk
  it.each([
    ["bun-1.4", "deploy", undefined, true],
    ["bun-1.4", "deploy", false, false],
    ["bun-1.4", "dev", undefined, false],
    ["bun-legacy", "deploy", undefined, false],
    ["bun", "deploy", undefined, false],
    ["node-24", "deploy", undefined, false],
  ] as const)(
    "%s %s with bunBytecode %s adds the compiled worker banner: %s",
    async (runtime, target, bunBytecode, expected) => {
      const options = await createBuildOptions({
        target,
        destination: "/out",
        cwd: "/project",
        resolvedConfig: configFor(runtime, bunBytecode),
        entryPoints: [],
      });

      expect(options.banner?.js?.includes("import.meta.url=") ?? false).toBe(expected);
    }
  );
});

describe("bundle layout", () => {
  // Catches: project files landing under the path of a CLI installed outside the project (npx
  // cache, global install), away from where additionalFiles copies the assets next to them
  it.each([
    ["outside the project", ["cli"]],
    ["in the project's node_modules", ["home", "dev", "project"]],
  ])("keeps the project layout with the CLI %s", async (_, cliRoot) => {
    const dir = await mkdtemp(join(tmpdir(), "trigger-bundle-layout-"));
    const project = join(dir, "home", "dev", "project");
    const destination = join(dir, "out");
    const runWorker = join(
      dir,
      ...cliRoot,
      "node_modules",
      "trigger.dev",
      "dist",
      "esm",
      "entryPoints",
      "managed-run-worker.js"
    );

    try {
      await mkdir(join(project, "src", "trigger"), { recursive: true });
      await mkdir(dirname(runWorker), { recursive: true });
      await writeFile(join(project, "trigger.config.ts"), "export default {};");
      await writeFile(join(project, "src", "trigger", "tasks.ts"), "export const task = 1;");
      await writeFile(runWorker, "console.log(1);");

      const resolvedConfig = { ...configFor("node-24"), workingDir: project };
      const options = await createBuildOptions({
        target: "deploy",
        destination,
        cwd: project,
        resolvedConfig,
        entryPoints: [
          join(project, "trigger.config.ts"),
          join(project, "src", "trigger", "tasks.ts"),
          runWorker,
        ],
      });
      // The shim is the CLI's built output, absent when running from source
      const result = await esbuild.build({ ...options, inject: [] });
      const bundle = await getBundleResultFromBuild("deploy", project, resolvedConfig, result);

      expect(bundle?.configPath).toBe(join(destination, "trigger.config.mjs"));
      expect(bundle?.files.map((file) => file.out)).toEqual([
        join(destination, "src", "trigger", "tasks.mjs"),
      ]);
      expect(bundle?.runWorkerEntryPoint?.startsWith(destination)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function dockerAvailable() {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

describe.skipIf(process.platform !== "linux" || !dockerAvailable())("compiled bun worker", () => {
  // Catches: a Bun upgrade that makes import.meta read-only or changes the embedded paths, so
  // compiled tasks see file:///$bunfs/root/ URLs and can't read files next to them in /app, or
  // fork() and spawn(process.execPath) start the run worker again instead of bun
  it("points import.meta at the files under /app and relaunches run bun", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trigger-bun-compile-"));
    const out = join(dir, "out");

    try {
      const files: Record<string, string> = {
        // Imports the task from inside the executable, as the run worker does
        "worker.ts": `if (process.env.RELAUNCHED) {
  console.log("run worker");
  process.exit(0);
}
const task = await import(["", "$bunfs", "root", "src/trigger/task.mjs"].join("/"));
console.log(JSON.stringify(await task.probe()));`,
        "src/trigger/task.ts": `import { fork, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const env = { ...process.env, RELAUNCHED: "1" };
export async function probe() {
  const child = fork(import.meta.dirname + "/child.mjs", { env, stdio: "pipe" });
  let forked = "";
  child.stdout!.on("data", (chunk) => (forked += chunk));
  await new Promise((resolve) => child.on("exit", resolve));
  return {
    url: import.meta.url,
    dirname: import.meta.dirname,
    data: readFileSync(new URL("./data.json", import.meta.url), "utf8"),
    forked: forked.trim(),
    spawned: spawnSync(process.execPath, ["-e", "console.log(typeof Bun)"], { env, encoding: "utf8" }).stdout.trim(),
  };
}`,
      };

      for (const [path, contents] of Object.entries(files)) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), contents);
      }

      const options = await createBuildOptions({
        target: "deploy",
        destination: out,
        cwd: dir,
        resolvedConfig: configFor("bun-1.4"),
        entryPoints: [join(dir, "worker.ts"), join(dir, "src/trigger/task.ts")],
      });
      await esbuild.build({ ...options, write: true });
      // A file shipped next to the task, as additionalFiles would
      await writeFile(join(out, "src/trigger/data.json"), '"next to the task"');
      await writeFile(join(out, "src/trigger/child.mjs"), 'console.log("child")');

      const outfile = "/app/.trigger/worker/run-worker";
      const args = bunCompileArgs({
        outfile,
        entryPoints: ["/app/worker.mjs", "/app/src/trigger/task.mjs"],
      });
      const script = `${args.map((arg) => `'${arg}'`).join(" ")} >/dev/null && ${outfile}`;

      const result = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--user",
          `${process.getuid!()}:${process.getgid!()}`,
          "-e",
          "HOME=/tmp",
          "-v",
          `${out}:/app`,
          "-w",
          "/app",
          "--entrypoint",
          "sh",
          BUILD_IMAGE["bun-1.4"],
          "-c",
          script,
        ],
        { encoding: "utf8" }
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        url: "file:///app/src/trigger/task.mjs",
        dirname: "/app/src/trigger",
        data: '"next to the task"',
        forked: "child",
        spawned: "object",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
