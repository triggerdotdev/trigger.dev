import { Command } from "commander";
import { z } from "zod";
import { CommonCommandOptions, handleTelemetry, wrapCommandAction } from "../cli/common.js";
import { printInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { printBundleTree, printBundleSummaryTable } from "../utilities/analyze.js";
import path from "node:path";
import fs from "node:fs";
import { readJSONFile } from "../utilities/fileSystem.js";
import { WorkerManifest } from "@trigger.dev/core/v3";
import { tryCatch } from "@trigger.dev/core";

const AnalyzeOptions = CommonCommandOptions.pick({
  logLevel: true,
  skipTelemetry: true,
  profile: true,
}).extend({
  verbose: z.boolean().optional().default(false),
});

type AnalyzeOptions = z.infer<typeof AnalyzeOptions>;

export function configureAnalyzeCommand(program: Command) {
  return program
    .command("analyze [dir]", { hidden: true })
    .description("Analyze your build output (bundle size, timings, etc)")
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .option("--skip-telemetry", "Opt-out of sending telemetry")
    .option("--verbose", "Show detailed bundle tree (do not collapse bundles)")
    .action(async (dir, options) => {
      await handleTelemetry(async () => {
        await analyzeCommand(dir, options);
      });
    });
}

export async function analyzeCommand(dir: string | undefined, options: unknown) {
  return await wrapCommandAction("analyze", AnalyzeOptions, options, async (opts) => {
    await printInitialBanner(false, opts.profile);
    return await analyze(dir, opts);
  });
}

export async function analyze(dir: string | undefined, options: AnalyzeOptions) {
  const cwd = process.cwd();
  const targetDir = dir ? path.resolve(cwd, dir) : cwd;
  const metafilePath = path.join(targetDir, "metafile.json");
  const manifestPath = path.join(targetDir, "index.json");

  if (!fs.existsSync(metafilePath)) {
    logger.error(`Could not find metafile.json in ${targetDir}`);
    logger.info("Make sure you have built your project and metafile.json exists.");
    return;
  }
  if (!fs.existsSync(manifestPath)) {
    logger.error(`Could not find index.json (worker manifest) in ${targetDir}`);
    logger.info("Make sure you have built your project and index.json exists.");
    return;
  }

  const [metafileError, metafile] = await tryCatch(readMetafile(metafilePath));

  if (metafileError) {
    logger.error(`Failed to parse metafile.json: ${metafileError.message}`);
    return;
  }

  const [manifestError, manifest] = await tryCatch(readManifest(manifestPath));

  if (manifestError) {
    logger.error(`Failed to parse index.json: ${manifestError.message}`);
    return;
  }

  printBundleTree(manifest, metafile, {
    preservePath: true,
    collapseBundles: !options.verbose,
  });

  printBundleSummaryTable(manifest, metafile, {
    preservePath: true,
  });
}

async function readMetafile(metafilePath: string): Promise<Metafile> {
  const json = await readJSONFile(metafilePath);
  const metafile = MetafileSchema.parse(json);
  return metafile;
}

async function readManifest(manifestPath: string): Promise<WorkerManifest> {
  const json = await readJSONFile(manifestPath);
  const manifest = WorkerManifest.parse(json);
  return manifest;
}

const ImportKind = z.enum([
  "entry-point",
  "import-statement",
  "require-call",
  "dynamic-import",
  "require-resolve",
  "import-rule",
  "composes-from",
  "url-token",
]);

const ImportSchema = z.object({
  path: z.string(),
  kind: ImportKind,
  external: z.boolean().optional(),
  original: z.string().optional(),
  with: z.record(z.string()).optional(),
});

const InputSchema = z.object({
  bytes: z.number(),
  imports: z.array(ImportSchema),
  format: z.enum(["cjs", "esm"]).optional(),
  with: z.record(z.string()).optional(),
});

const OutputImportSchema = z.object({
  path: z.string(),
  kind: z.union([ImportKind, z.literal("file-loader")]),
  external: z.boolean().optional(),
});

const OutputInputSchema = z.object({
  bytesInOutput: z.number(),
});

const OutputSchema = z.object({
  bytes: z.number(),
  inputs: z.record(z.string(), OutputInputSchema),
  imports: z.array(OutputImportSchema),
  exports: z.array(z.string()),
  entryPoint: z.string().optional(),
  cssBundle: z.string().optional(),
});

const MetafileSchema = z.object({
  inputs: z.record(z.string(), InputSchema),
  outputs: z.record(z.string(), OutputSchema),
});

type Metafile = z.infer<typeof MetafileSchema>;
